module.exports = function (RED) {

    // http response codes
    var RESP_OK        = 200;
    var RESP_NO_CONT   = 204;
    var RESP_BAD_REQ   = 400;
    var RESP_UNAUTH    = 401;
    var RESP_NOT_FOUND = 404;
    var RESP_INTER_ERR = 500;

    // libraries
    var https = require("https");
    var http = require("http");
    var urllib = require("url");
    var WebSocketServer = require('ws').Server;
    var ifaces = require('os').networkInterfaces();

    // constants
    var WS_PATH     = "websocket";
    var VALUE_CONT  = "application/json";
    var VALUE_AUTH  = "Bearer";
    var METHOD_GET  = "get";
    var METHOD_POST = "post";

    // prune sheet states
    var PRUNE_OK            = 0;
    var PRUNE_NOT_FOUND_ERR = 1;
    var PRUNE_DELEGATE_ERR  = 2;
    var PRUNE_UNKNOWN_ERR   = 3;

    var IS_DEVEL = true;
    if(RED.settings.functionGlobalContext.is_devel) {
        IS_DEVEL = RED.settings.functionGlobalContext.is_devel;
    }

    // global variables
    var WSS_LIST = {};


    function init_remote_deploy(node) {
        on_dispatch_auto_get(node);
    }


    function show_succ_dispatch_msg(node, status_code, url) {
        var msg = "[DONE] message: set destination flow OK\n" +
                  "[DONE]  status: " + status_code + "\n" +
                  "[DONE]     url: " + url + "\n";

        node.status({});
        node.send({"payload": msg});
        console.log(msg);
    }


    function show_error_msg(node, info, status_code, url) {
        var msg = "[ERROR] " + info;
        if(status_code || url) {
            msg = msg + " (" +
                (status_code? ("code: " + status_code + ", ") : "") +
                (url? ("url: " + url) : "") + ")";
        }

        node.status({
            fill: "red", shape: "ring",
            text: (status_code? status_code + ": " : "") + info
        });
        console.log(msg);
    }


    // enable or disable security checks for https certificate
    function set_https_secure_check(is_enable) {
        if(!is_enable) {
            console.log("[INFO] Turn OFF https security checks");

            // disable https security checks to avoid DEPTH_ZERO_SELF_SIGNED_CERT error
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
        } else if(typeof process.env.NODE_TLS_REJECT_UNAUTHORIZED !== 'undefined') {
            console.log("[INFO] Turn ON https security checks");

            // enable https security checks
            delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        }
    }


    // send http request, on_end_handler will be triggered by 'end' event
    function send_request(node, send_url, method, headers, post_body, on_end_handler, on_err_handler) {
        node.status({});
        var opts = urllib.parse(send_url);
            opts.method = method;
            opts.headers = headers;

        var protocol = http;
        if(/^https/i.test(send_url)) {
            protocol = https;

            // disable check if is develop environment
            set_https_secure_check(!IS_DEVEL);
        }

        var resp = {};
        var req = protocol.request(opts, function(res) {
            res.setEncoding('utf8');

            resp.statusCode = res.statusCode;
            resp.headers = res.headers;
            resp.payload = "";
            resp.statusMessage = res.statusMessage;

            res.on('data', function(chunk) {
                resp.payload += chunk;
            });

            res.on('end', function() {
                if(/^https/i.test(send_url)) {
                    // enable check if is develop environment
                    set_https_secure_check(IS_DEVEL);
                }

                if(on_end_handler) {
                    on_end_handler(resp);
                }
            });
        }).on('error', function(err) {
            resp.statusCode = err.code;
            show_error_msg(node, "Request Fail", resp.statusCode, send_url);

            if(/^https/i.test(send_url)) {
                // enable check if is develop environment
                set_https_secure_check(IS_DEVEL);
            }

            if(on_err_handler) {
                on_err_handler(resp);
            }
        });

        if((method.toLowerCase() === METHOD_POST.toLowerCase()) && post_body) {
            // write post content
            req.write(post_body);
        }

        req.end();
    }


    // invoke access token
    function request_invoke_token(node, on_token_available) {
        var send_url = node.protocol + "://" + node.url + "/auth/token";
        var hdrs = {"Authorization": VALUE_AUTH, "Content-type": VALUE_CONT};
        var cred = JSON.stringify({
            "client_id": "node-red-admin"
            , "grant_type": "password"
            , "scope": "*"
            , "username": (node.credentials.user)? node.credentials.user.trim() : ""
            , "password": (node.credentials.password)? node.credentials.password : ""
        });

        send_request(node, send_url, METHOD_POST, hdrs, cred, function(resp) {
            if(resp.statusCode === RESP_OK) {
                try {
                    // got access token
                    var token = JSON.parse(resp.payload).access_token;
                    if(on_token_available) {
                        var hdrs = {
                            "Authorization": VALUE_AUTH + " " + token
                            , "Content-type": VALUE_CONT
                        };
                        on_token_available(node, hdrs);
                    }
                } catch(e) {
                    // fail to parse access token
                    show_error_msg(node, "Fail to parse token.", null, send_url)
                }
            } else {
                // fail to get access token
                show_error_msg(node, resp.statusMessage, resp.statusCode, send_url);
            }
        });
    }


    // revoke access token
    function request_revoke_token(node, token) {
        var send_url = node.protocol + "://" + node.url + "/auth/revoke";
        var hdrs = {
            "Authorization": VALUE_AUTH + " " + token
            , "Content-type": VALUE_CONT
        };

        send_request(node, send_url, METHOD_POST, hdrs, JSON.stringify({"token": token}), function(resp) {
            var info = "[INFO] revoke token url: " + send_url + "\n" +
                (
                    (resp.statusCode === RESP_OK)? ("[INFO] succ to revoke token: " + token) : (
                        "[WARN] fail to revoke token: " + token +
                        " (" + "code: " + resp.statusCode + ", " + resp.statusMessage + ")"
                    )
                );

            console.log(info);
        });
    }


    // callback when receive response from on-dispatch-get-flow request
    function on_dispatch_get_end(node, resp) {
        if(resp.statusCode === RESP_OK) {
            on_dispatch_auto_set(node, resp);
        } else if((resp.statusCode == RESP_UNAUTH || resp.statusCode == RESP_BAD_REQ) && node.is_auth) {
            // require local authentication
            request_invoke_token(node, function(node, headers) {
                // get local flows with token
                var send_url = node.protocol + "://" + node.url + "/flows";
                send_request(node, send_url, METHOD_GET, headers, null,
                    function(resp) {
                        // destroy local token
                        request_revoke_token(node, headers.Authorization.substr(VALUE_AUTH.length + 1));

                        on_dispatch_auto_set(node, resp);
                    }
                    , function(resp) {
                        // destroy local token
                        request_revoke_token(node, headers.Authorization.substr(VALUE_AUTH.length + 1));
                    }
                );
            });
        } else {
            show_error_msg(node, "Fail to get local flow.", resp.statusCode, node.url);
        }
    }


    // callback when error caused by on_dispatch_auto_get request
    function on_dispatch_get_error(node, resp) {
        if(resp.statusCode === 'ECONNRESET') {
            // try https without authentication
            node.url = node.local_url;
            node.protocol = "https"
            var send_url = node.protocol + "://" + node.url + "/flows";
            console.log("[INFO] HTTP on-dispatch-get-flow fail, try HTTPS: " + send_url);
            send_request(node, send_url, METHOD_GET, {"Authorization": VALUE_AUTH}, null
                , function(resp) {
                    on_dispatch_get_end(node, resp);
                }
                // if error still occurs, do nothing
            );
        }
    }


    // start to get a sheet from node.local_url
    function on_dispatch_auto_get(node) {
        // get local flow, try http without authentication
        node.url = node.local_url;
        node.protocol = "http";
        var send_url = node.protocol + "://" + node.url + "/flows";

        send_request(node, send_url, METHOD_GET, {"Authorization": VALUE_AUTH}, null
            , function(resp) {  // callback on response returned
                on_dispatch_get_end(node, resp);
            }
            , function(resp) {  // callback on error occurs
                on_dispatch_get_error(node, resp);
            }
        );
    }


    // callback when receive response from on_dispatch_auto_set request
    function on_dispatch_set_end(node, send_url, flows, resp) {
        if(resp.statusCode === RESP_NO_CONT) {
            show_succ_dispatch_msg(node, resp.statusCode, send_url);
        } else if((resp.statusCode == RESP_UNAUTH || resp.statusCode == RESP_BAD_REQ) && node.is_auth) {
            // require destination authentication
            request_invoke_token(node, function(node, hdrs) {
                // set flows with token
                send_request(node, send_url, METHOD_POST, hdrs, flows,
                    function(resp) {
                        // destroy destination token
                        request_revoke_token(node, hdrs.Authorization.substr(VALUE_AUTH.length + 1));

                        if(resp.statusCode === RESP_NO_CONT) {
                            show_succ_dispatch_msg(node, resp.statusCode, send_url);
                        } else {
                            show_error_msg(node, resp.statusMessage, resp.statusCode, send_url);
                        }
                    }
                    , function(resp) {
                        // destroy destination token
                        request_revoke_token(node, hdrs.Authorization.substr(VALUE_AUTH.length + 1));
                    }
                );
            });
        } else {
            show_error_msg(node, resp.statusMessage, resp.statusCode, send_url);
        }
    }


    // callback when error caused by on_dispatch_auto_set request
    function on_dispatch_set_error(node, headers, flows, resp) {
        if(resp.statusCode === 'ECONNRESET') {
            // try https without authentication
            node.protocol = "https"
            var send_url = node.protocol + "://" + node.dest_url + "/flows";
            console.log("[INFO] HTTP on-dispatch-set-flow fail, try HTTPS: " + send_url);
            send_request(node, send_url, METHOD_POST, headers, flows
                , function(resp) {
                    on_dispatch_set_end(node, send_url, flows, resp);
                }
            );
        }
    }


    // start to set a sheet to destination
    function on_dispatch_auto_set(node, resp) {
        var prune = sheet_prune(JSON.parse(resp.payload), node);

        if(prune.status === PRUNE_OK) {
            // get local sheet ok, try to dispatch it using http without authentication
            node.url = node.dest_url;
            node.protocol = "http";
            var send_url = node.protocol + "://" + node.url + "/flows";
            var flows = JSON.stringify(prune.flow);
            var hdrs = {"Authorization": VALUE_AUTH, "Content-type": VALUE_CONT}
            send_request(node, send_url, METHOD_POST, hdrs, flows
                , function(resp) {
                    on_dispatch_set_end(node, send_url, flows, resp);
                }
                , function(resp) {
                    on_dispatch_set_error(node, hdrs, flows, resp);
                }
            );
        } else {
            show_error_msg(node, prune.msg, null, null);
        }
    }


    // find all subflows that will be dispatched to destination
    //   - added_subs: new included subflows
    //   -   now_subs: all included subflows
    function traverse_subflows(flows, added_subs, now_subs) {
        var prefix = "subflow:";
        var subs = [];

        for(var k in flows) {
            if(~added_subs.indexOf(flows[k].z) && !flows[k].type.indexOf(prefix)) {
                var sub_id = flows[k].type.substr(prefix.length);
                if(!~subs.indexOf(sub_id) && !~now_subs.indexOf(sub_id)) {
                    // push the node if not currently included
                    subs.push(sub_id);
                }
            }
        }

        return (subs.length? traverse_subflows(flows, subs, now_subs.concat(subs)) : now_subs);
    }


    // get flows/nodes will be dispatched
    function sheet_prune(flows, node) {
        var pruned_flow = null;
        var pruned_stat = PRUNE_OK;
        var pruned_msg  = "Prune ok";
        var tab_id = null;

        var get_node_id = function() {
            return (1 + Math.random()*4294967295).toString(16);
        };

        // find user specified tab id
        for(var k in flows) {
            if((flows[k].type === "tab") && (flows[k].label === node.sheet)) {
                tab_id = flows[k].id;
                break;
            }
        }

        if(tab_id) {
            try {
                var sub_flows = traverse_subflows(flows, [tab_id], []);

                var protocol = (/^https$/i.test(node.protocol))? "wss" : "ws";
                var node_id = get_node_id();
                var ws_cfg = {
                    "id": node_id
                    , "type": "websocket-client"
                    , "path": (protocol + "://" + node.local_url + "/" + node.id)
                    , "wholemsg": "false"
                };

                pruned_flow = [];
                var d_in = d_out = 0;
                for(var k in flows) {
                    if((flows[k].id === tab_id)         ||                                    // 1: user specified tab
                       (flows[k].z === tab_id)          ||                                    // 2: nodes on user specified tab
                       (~sub_flows.indexOf(flows[k].z)) ||                                    // 3: nodes on dispatched subflows
                       ((flows[k].type === "subflow") && ~sub_flows.indexOf(flows[k].id))) {  // 4: dispatched subflows

                        // repace delegate nodes with websocket-client
                        if((flows[k].type === "flow-dlg-in" || flows[k].type === "flow-dlg-out")) {
                            // push configuration node for websocket-client
                            if(!~pruned_flow.indexOf(ws_cfg)) {
                                pruned_flow.push(ws_cfg);
                            }

                            // replace delegate-in node with websocket-in node
                            flows[k].server = "";
                            flows[k].client = node_id;
                            if(flows[k].type === "flow-dlg-in") {
                                ++d_in;

                                // add a function node to remove msg._session from websocket input
                                node_id = get_node_id();
                                func_node = {
                                    "id": node_id
                                    , "type": "function"
                                    , "name":"reset-ws-sess"
                                    , "func":"if(msg._session) {\n" +
                                             "    msg.session_in = msg._session;\n" +
                                             "    delete msg._session;\n" +
                                             "}\n" +
                                             "return msg;"
                                    , "outputs": 1
                                    , "noerr": 0
                                    , "x": flows[k].x
                                    , "y": flows[k].y + 50
                                    , "z": flows[k].z
                                    , "wires": flows[k].wires
                                };
                                pruned_flow.push(func_node);

                                // connect websocket-in to above function node
                                flows[k].type = "websocket in";
                                flows[k].wires = [[node_id]];
                            } else {
                                ++d_out;
                                flows[k].type = "websocket out";
                            }
                        }

                        pruned_flow.push(flows[k]);  // push this node
                    } else if(!(flows[k].type === "tab" || flows[k].type === "subflow") &&  // 1: neither a tab nor a subflow
                              !(flows[k].x || flows[k].y || flows[k].z)) {                  // 2: no x, y and z property
                        // push configuration node
                        pruned_flow.push(flows[k]);
                    }
                }

                if(!(d_in || d_out)) {
                    pruned_msg = "Neither delegate-in node nor delegate-out node exists.";
                    pruned_stat = PRUNE_DELEGATE_ERR;
                } else if((d_in > 1) || (d_out > 1)) {
                    pruned_msg = "Number of delegate nodes error. " +
                                 "(#dlg-in: " + d_in + ", #dlg-out: " + d_out + ")";
                    pruned_stat = PRUNE_DELEGATE_ERR;
                }
            } catch(err) {
                pruned_stat = PRUNE_UNKNOWN_ERR;
                pruned_msg = "Exception while sheet pruning.";
                pruned_flow = null;

                node.status({fill: "red", shape: "ring", text: pruned_msg});
                console.log(pruned_msg);
            }
        } else {
            pruned_stat = PRUNE_NOT_FOUND_ERR;
            pruned_msg = "Sheet not found (" + node.sheet + ")";
            node.status({fill: "red", shape: "ring", text: pruned_msg});
        }

        return {
            "status": pruned_stat
            , "flow": pruned_flow
            , "msg" : pruned_msg
        };
    }


    // delete unnecessary websocket listener
    function purge_wss_list() {
        for(var k in WSS_LIST) {
            var n = RED.nodes.getNode(k);
            if(!n) {
                console.log("remove wss: " + k);
                delete WSS_LIST[k];
            }
        }

        console.log("WSS_LIST: " + Object.keys(WSS_LIST));
    }


    function WSRetrieveNode(config) {
        RED.nodes.createNode(this, config);

        var node = this;
        node.local_url = config.lcl_url.replace(/^http:\/\/|^https:\/\/|\/$/gi,"");
        node.dest_url = config.dest_url.replace(/^http:\/\/|^https:\/\/|\/$/gi,"");
        node.is_auth = config.auth;
        node.sheet = config.sheet;

        if(!(node.id in WSS_LIST)) {
            var wss = new WebSocketServer({server:RED.server, path: "/" + node.id});

            wss.on('connection', function (ws) {
                console.log('connection: ', ws.upgradeReq.connection.remoteAddress);

                ws.on('message', function (message) {
                    node.send({"payload": message});
                });

                ws.on('close', function () {
                    console.log('websocket close');
                });

                ws.on('error', function (e) {
                    console.log('websocket error: ' + e);
                });
            });

            wss.broadcast = function broadcast(data) {
                wss.clients.forEach(function each(client) {
                    client.send(data);
                });
            };

            WSS_LIST[node.id] = wss;
            console.log("WSS_LIST: " + Object.keys(WSS_LIST));
        }

        node.on('input', function (msg) {
            WSS_LIST[node.id].broadcast(msg.payload);
        });
    }


    function delegate_input(config) {
        RED.nodes.createNode(this, config);
    }


    function delegate_output(config) {
        RED.nodes.createNode(this, config);
    }


    // register nodes
    RED.nodes.registerType("comm", WSRetrieveNode, {
        credentials: {
            user: {type:"text"}
            , password: {type: "password"}
        }
    });

    RED.nodes.registerType("flow-dlg-in", delegate_input);

    RED.nodes.registerType("flow-dlg-out", delegate_output);

    // callback to get local url
    RED.httpAdmin.get("/get_local_url", function(req, res) {
        var address = "127.0.0.1";
        var ui_port = "1880";
        var local_url = address + ":" + ui_port;
        try {
            // Iterate over interfaces
            for (var dev in ifaces) {
                // find the one that matches the criteria
                var iface = ifaces[dev].filter(function(details) {
                    return details.family === 'IPv4' && details.internal === false;
                });

                if(iface.length > 0) {
                    // return first matched address
                    address = iface[0].address;
                }
            }

            local_url = (address + ":" + (RED.settings.uiPort? RED.settings.uiPort : ui_port));
        } catch(err) {
            console.log("[WARN] get local url fail, use default: " + local_url);
        } finally {
            res.send(local_url);
        }
    });


    // triggered by WS button clicked
    RED.httpAdmin.get("/remote-deploy/:id", RED.auth.needsPermission("inject.write"), function(req, res) {
        var node = RED.nodes.getNode(req.params.id);
        if (node != null) {
            try {
                purge_wss_list();

                init_remote_deploy(node);
                res.send(RESP_OK);
            } catch(err) {
                res.send(RESP_INTER_ERR);
            }
        } else {
            res.send(RESP_NOT_FOUND);
        }
    });
};

