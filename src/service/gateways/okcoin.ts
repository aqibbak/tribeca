/// <reference path="../../../typings/tsd.d.ts" />
/// <reference path="../utils.ts" />
/// <reference path="../../common/models.ts" />
/// <reference path="nullgw.ts" />

import ws = require('ws');
import Q = require("q");
import crypto = require("crypto");
import request = require("request");
import url = require("url");
import querystring = require("querystring");
import Config = require("../config");
import NullGateway = require("./nullgw");
import Models = require("../../common/models");
import Utils = require("../utils");
import Interfaces = require("../interfaces");
var shortId = require("shortid");

interface OkCoinMessageIncomingMessage {
    channel : string;
    success : string;
    data : any;
    event? : string;
}

interface OkCoinDepthMessage {
    asks : [number, number][];
    bids : [number, number][];
    timestamp : string;
}

interface OkCoinExecutionReport {
    exchangeId : string;
    orderId : string;
    orderStatus : string;
    rejectMessage : string;
    lastQuantity: number;
    lastPrice : number;
    leavesQuantity : number;
    cumQuantity : number;
    averagePrice : number;
}

class OkCoinWebsocket {
	send = <T>(eventName: string, data : T) => {
		
	};
	
    subscribe = <T>(channel : string, handler: (newMsg : Models.Timestamped<T>) => void) => {
        var subsReq = {event: 'addChannel',
                       channel: channel,
                       parameters: {partner: this._partner,
                                    secretkey: this._secretKey}};
        this._ws.send(JSON.stringify(subsReq));
        this._handlers[channel] = handler;
    }

    private onMessage = (raw : string) => {
        var t = Utils.date();
        try {
            var msg : OkCoinMessageIncomingMessage = JSON.parse(raw)[0];

            if (typeof msg.event !== "undefined" && msg.event == "ping") {
                this._ws.send(this._serializedHeartbeat);
                return;
            }

            if (typeof msg.success !== "undefined") {
                if (msg.success !== "true")
                    this._log("Unsuccessful message %o", msg);
                else
                    this._log("Successfully connected to %s", msg.channel);
                return;
            }

            var handler = this._handlers[msg.channel];

            if (typeof handler === "undefined") {
                this._log("Got message on unknown topic %o", msg);
                return;
            }

            handler(new Models.Timestamped(msg.data, t));
        }
        catch (e) {
            this._log("Error parsing msg %o", raw);
            throw e;
        }
    };

    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();
    _serializedHeartbeat = JSON.stringify({event: "pong"});
    _log : Utils.Logger = Utils.log("tribeca:gateway:OkCoinWebsocket");
    _secretKey : string;
    _partner : string;
    _handlers : { [channel : string] : (newMsg : Models.Timestamped<any>) => void} = {};
    _ws : ws;
    constructor(config : Config.IConfigProvider) {
        this._partner = config.GetString("OkCoinPartner");
        this._secretKey = config.GetString("OkCoinSecretKey");
        this._ws = new ws(config.GetString("OkCoinWsUrl"));

        this._ws.on("open", () => this.ConnectChanged.trigger(Models.ConnectivityStatus.Connected));
        this._ws.on("message", this.onMessage);
        this._ws.on("close", () => this.ConnectChanged.trigger(Models.ConnectivityStatus.Disconnected));
    }
}

class OkCoinMarketDataGateway implements Interfaces.IMarketDataGateway {
    MarketData = new Utils.Evt<Models.Market>();
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();

    // TODO
    MarketTrade = new Utils.Evt<Models.GatewayMarketTrade>();

    private onDepth = (depth : Models.Timestamped<OkCoinDepthMessage>) => {
        var msg = depth.data;

        var getLevel = n => new Models.MarketSide(n[0], n[1]);
        var mkt = new Models.Market(msg.bids.map(getLevel), msg.asks.map(getLevel), depth.time);

        this.MarketData.trigger(mkt);
    };

    constructor(socket : OkCoinWebsocket) {
        socket.ConnectChanged.on(cs => {
            if (cs == Models.ConnectivityStatus.Connected)
                socket.subscribe("ok_btcusd_depth", this.onDepth);
            this.ConnectChanged.trigger(cs);
        });
    }
}

interface OrderAck {
    result: boolean;
    order_id: number;
}

class OkCoinOrderEntryGateway implements Interfaces.IOrderEntryGateway {
    OrderUpdate = new Utils.Evt<Models.OrderStatusReport>();
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();

    generateClientOrderId = () => {
        return shortId.generate();
    }

    public cancelsByClientOrderId = false;
    
    private static GetOrderType(side: Models.Side, type: Models.OrderType) : string {
        if (side === Models.Side.Bid) {
            if (type === Models.OrderType.Limit) return "buy";
            if (type === Models.OrderType.Market) return "buy_market";
        }
        if (side === Models.Side.Ask) {
            if (type === Models.OrderType.Limit) return "sell";
            if (type === Models.OrderType.Market) return "sell_market";
        }
        throw new Error("unable to convert " + Models.Side[side] + " and " + Models.OrderType[type]);
    }

    sendOrder = (order : Models.BrokeredOrder) : Models.OrderGatewayActionReport => {
        var o = {
            //api_key: "API KEY",
            //sign: "SIGNATURE",
            symbol: "btc_usd", //btc_usd: bitcoin ltc_usd: litecoin,
            type: OkCoinOrderEntryGateway.GetOrderType(order.side, order.type),
            price: order.price,
            amount: order.quantity};
            
        this._http.post<OrderAck>("trade.do", o).then(ts => {
            var osr : Models.OrderStatusReport = { time: ts.time };
            
            if (ts.data.result === true) {
                osr.exchangeId = ts.data.order_id.toString();
                osr.orderStatus = Models.OrderStatus.Working;
            } 
            else {
                osr.orderStatus = Models.OrderStatus.Rejected;
            }
            
            this.OrderUpdate.trigger(osr);
        }).done();

        return new Models.OrderGatewayActionReport(Utils.date());
    };

    cancelOrder = (cancel : Models.BrokeredCancel) : Models.OrderGatewayActionReport => {
        this._http.post<OrderAck>("cancel_order.do", {orderId: cancel.exchangeId }).then(ts => {
            var osr : Models.OrderStatusReport = { time: ts.time };
            
            if (ts.data.result === true) {
                osr.orderStatus = Models.OrderStatus.Cancelled;
            }
            else {
                osr.orderStatus = Models.OrderStatus.Rejected;
                osr.cancelRejected = true;
            }
            
            this.OrderUpdate.trigger(osr);
        });
        return new Models.OrderGatewayActionReport(Utils.date());
    };

    replaceOrder = (replace : Models.BrokeredReplace) : Models.OrderGatewayActionReport => {
        this.cancelOrder(new Models.BrokeredCancel(replace.origOrderId, replace.orderId, replace.side, replace.exchangeId));
        return this.sendOrder(replace);
    };

    private onMessage = (tsMsg : Models.Timestamped<OkCoinExecutionReport>) => {
        var t = tsMsg.time;
        var msg : OkCoinExecutionReport = tsMsg.data;

        var orderStatus = OkCoinOrderEntryGateway.getStatus(msg.orderStatus);
        var status : Models.OrderStatusReport = {
            exchangeId: msg.exchangeId,
            orderId: msg.orderId,
            orderStatus: orderStatus,
            time: t,
            lastQuantity: msg.lastQuantity > 0 ? msg.lastQuantity : undefined,
            lastPrice: msg.lastPrice > 0 ? msg.lastPrice : undefined,
            leavesQuantity: orderStatus == Models.OrderStatus.Working ? msg.leavesQuantity : undefined,
            cumQuantity: msg.cumQuantity > 0 ? msg.cumQuantity : undefined,
            averagePrice: msg.averagePrice > 0 ? msg.averagePrice : undefined,
            pendingCancel: msg.orderStatus == "6",
            pendingReplace: msg.orderStatus == "E"
        };

        this.OrderUpdate.trigger(status);
    };

    _log : Utils.Logger = Utils.log("tribeca:gateway:OkCoinOE");
    constructor(private _socket : OkCoinWebsocket, private _http: OkCoinHttp) {
        _socket.subscribe("ExecRpt", this.onMessage);
        _socket.ConnectChanged.on(cs => this.ConnectChanged.trigger(cs));
    }
}

class OkCoinHttp {
    private signMsg = (m : { [key: string]: string }) => {
        var els : string[] = [];

        var keys = [];
        for (var key in m) {
            if (m.hasOwnProperty(key))
                keys.push(key);
        }
        keys.sort();

        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            if (m.hasOwnProperty(key))
                els.push(key + "=" + m[key]);
        }

        var sig = els.join("&") + "&secret_key=" + this._secretKey;
        return crypto.createHash('md5').update(sig).digest("hex").toString().toUpperCase();
    };

    post = <T>(actionUrl: string, msg : any) : Q.Promise<Models.Timestamped<T>> => {
        msg.partner = this._partner;
        msg.sign = this.signMsg(msg);
        
        var d = Q.defer<Models.Timestamped<T>>();

        request({
            url: url.resolve(this._baseUrl, actionUrl),
            body: querystring.stringify(msg),
            headers: {"Content-Type": "application/x-www-form-urlencoded"},
            method: "POST"
        }, (err, resp, body) => {
            if (err) d.reject(err);
            else {
                try {
                    var t = Utils.date();
                    var data = JSON.parse(body);
                    d.resolve(new Models.Timestamped(data, t));
                }
                catch (e) {
                    this._log("url: %s, err: %o, body: %o", actionUrl, err, body);
                    d.reject(e);
                }
            }
        });
        
        return d.promise;
    };

    _log : Utils.Logger = Utils.log("tribeca:gateway:OkCoinHTTP");
    _secretKey : string;
    _partner : string;
    _baseUrl : string;
    constructor(config : Config.IConfigProvider) {
        this._partner = config.GetString("OkCoinPartner");
        this._secretKey = config.GetString("OkCoinSecretKey");
        this._baseUrl = config.GetString("OkCoinHttpUrl")
    }
}

class OkCoinPositionGateway implements Interfaces.IPositionGateway {
    _log : Utils.Logger = Utils.log("tribeca:gateway:OkCoinPG");
    PositionUpdate = new Utils.Evt<Models.CurrencyPosition>();

    private static convertCurrency(name : string) : Models.Currency {
        switch (name.toLowerCase()) {
            case "usd": return Models.Currency.USD;
            case "ltc": return Models.Currency.LTC;
            case "btc": return Models.Currency.BTC;
            default: throw new Error("Unsupported currency " + name);
        }
    }

    private trigger = () => {
        this._http.post("userinfo.do", {}).then(msg => {
            var funds = (<any>msg.data).info.funds.free;
            var held = (<any>msg.data).info.funds.freezed;

            for (var currencyName in funds) {
                if (!funds.hasOwnProperty(currencyName)) continue;
                var val = funds[currencyName];

                var pos = new Models.CurrencyPosition(parseFloat(val), held, OkCoinPositionGateway.convertCurrency(currencyName));
                this.PositionUpdate.trigger(pos);
            }
        }).done();
    };

    constructor(private _http : OkCoinHttp) {
        this.trigger();
        setInterval(this.trigger, 15000);
    }
}

class OkCoinBaseGateway implements Interfaces.IExchangeDetailsGateway {
    public get hasSelfTradePrevention() {
        return false;
    }

    name() : string {
        return "OkCoin";
    }

    makeFee() : number {
        return 0.001;
    }

    takeFee() : number {
        return 0.002;
    }

    exchange() : Models.Exchange {
        return Models.Exchange.OkCoin;
    }
}

export class OkCoin extends Interfaces.CombinedGateway {
    constructor(config : Config.IConfigProvider) {
        var http = new OkCoinHttp(config);
        var socket = new OkCoinWebsocket(config);

        var orderGateway = config.GetString("OkCoinOrderDestination") == "OkCoin"
            ? <Interfaces.IOrderEntryGateway>new OkCoinOrderEntryGateway(socket, http)
            : new NullGateway.NullOrderGateway();

        super(
            new OkCoinMarketDataGateway(socket),
            orderGateway,
            new OkCoinPositionGateway(http),
            new OkCoinBaseGateway());
        }
}