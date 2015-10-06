/**
 * Copyright 2015 Brendan Murray
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

module.exports = function(RED) {
    "use strict";

    var https = require("https");
    var http = require("http");
    var urllib = require("url");

    // constants
    var LOCALHOST   = "localhost:1880";
    var VALUE_CONT  = "application/json";
    var VALUE_AUTH  = "Bearer";
    var METHOD_GET  = "get";
    var METHOD_POST = "post";

    // http response codes
    var RESP_OK        = 200;
    var RESP_NO_CONT   = 204;
    var RESP_BAD_REQ   = 400;
    var RESP_UNAUTH    = 401;
    var RESP_NOT_FOUND = 404;
    var RESP_INTER_ERR = 500;

    var IS_DEVEL = true;
    if(RED.settings.functionGlobalContext.is_devel) {
        IS_DEVEL = RED.settings.functionGlobalContext.is_devel;
    }

    // show msg on console when IS_DEVEL is false
    function show_console_msg(msg) {
        if(IS_DEVEL) {
            console.log(msg);
        }
    }


    // return error message string and set node status icon
    function get_error_msg(node, info, status_code, url) {
        node.status({
            fill: "red", shape: "ring",
            text: (status_code? status_code + ": " : "") + info
        });

        var msg = "[ERROR] " + info;
        if(status_code || url) {
            msg = msg + " (" +
                  (status_code? ("code: " + status_code + ", ") : "") +
                  (url? ("url: " + url) : "") + ")";
        }

        show_console_msg(msg);
        return msg;
    }


    // return message to indicate successfully dispatch flow
    function get_succ_dispatch_msg(node, status_code, url) {
        node.status({});  // clear node status

        var msg = "[DONE] message: set destination flow OK\n" +
                  "[DONE]  status: " + status_code + "\n" +
                  "[DONE]     url: " + url + "\n";

        show_console_msg(msg);
        return msg;
    }


    // send http request, on_end_handler will be triggered by 'end' event
    function send_request(node, send_url, method, headers, post_body, on_end_handler, on_err_handler) {
        var opts = urllib.parse(send_url);
            opts.method = method;
            opts.headers = headers;

        var protocol = http;
        if(/^https/.test(send_url)) {
            // https
            protocol = https;

            if(IS_DEVEL) {
                // disable security checks to avoid DEPTH_ZERO_SELF_SIGNED_CERT error
                process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
            }
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
                if(on_end_handler) {
                    on_end_handler(resp);
                }
            });
        }).on('error', function(err) {
            resp.statusCode = err.code;
            resp.payload = get_error_msg(node, "Request Fail", resp.statusCode, send_url);

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
                    resp.payload = get_error_msg(node, "Parse Fail", null, send_url);
                }
            } else {
                // fail to get access token
                resp.payload = get_error_msg(node, resp.statusMessage, resp.statusCode, send_url);
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

            show_console_msg(info);
        });
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
    function sheet_prune(flows, name) {
        var pruned = null;
        var tab_id = null;

        // find user specified tab id
        for(var k in flows) {
            if((flows[k].type === "tab") && (flows[k].label === name)) {
                tab_id = flows[k].id;
                break;
            }
        }

        if(tab_id) {
            var sub_flows = traverse_subflows(flows, [tab_id], []);

            pruned = [];
            for(var k in flows) {
                if((flows[k].id === tab_id)         ||                                    // 1: user specified tab
                   (flows[k].z  === tab_id)         ||                                    // 2: nodes on user specified tab
                   (~sub_flows.indexOf(flows[k].z)) ||                                    // 3: nodes on dispatched subflows
                   ((flows[k].type === "subflow") && ~sub_flows.indexOf(flows[k].id))) {  // 4: dispatched subflows
                    pruned.push(flows[k]);  // push this node
                }
            }
        }

        return pruned;
    }


    // send request to get NodeRed flows
    function request_get_flow(node, headers) {
        node.status({});

        var send_url = node.protocol + "://" + node.url + "/flows";
        send_request(node, send_url, METHOD_GET, headers, null, function(resp) {
            if(resp.statusCode === RESP_OK) {
                resp.payload = sheet_prune(JSON.parse(resp.payload), node.sheet);

                if(resp.payload) {
                    node.send(resp);
                    node.status({});
                } else {
                    var info = "Sheet Not Found (" + node.sheet + ")";
                    resp.payload = get_error_msg(node, info, null, null);
                }
            } else {
                resp.payload = get_error_msg(node, resp.statusMessage, resp.statusCode, send_url);
            }

            if(headers.Authorization.length > VALUE_AUTH.length) {
                var token = headers.Authorization.substr(VALUE_AUTH.length + 1);  // +1 to skip ' '
                request_revoke_token(node, token);
            }
        });
    }


    // send request to get NodeRed flows without access token
    function request_get_flow_without_token(node) {
        request_get_flow(node, {"Authorization": VALUE_AUTH});
    }


    // send request to get NodeRed flows with access token
    function request_get_flow_with_token(node) {
        request_invoke_token(node, request_get_flow);
    }


    // send request to set NodeRed flows
    function request_set_flow(node, headers) {
        node.status({});

        var send_url = node.protocol + "://" + node.url + "/flows";
        var flows = JSON.stringify(node.flows);

        send_request(node, send_url, METHOD_POST, headers, flows, function(resp) {
            if(resp.statusCode === RESP_NO_CONT) {
                resp.payload = get_succ_dispatch_msg(node, resp.statusCode, send_url);
            } else {
                resp.payload = get_error_msg(node, resp.statusMessage, resp.statusCode, send_url);
            }

            node.send(resp);
            if(headers.Authorization.length > VALUE_AUTH.length) {
                var token = headers.Authorization.substr(VALUE_AUTH.length + 1);  // +1 to skip ' '
                request_revoke_token(node, token);
            }
        });
    }


    // send request to get NodeRed flows without access token
    function request_set_flow_without_token(node) {
        request_set_flow(node, {"Authorization": VALUE_AUTH, "Content-type": VALUE_CONT});
    }


    // send request to get NodeRed flows with access token
    function request_set_flow_with_token(node) {
        request_invoke_token(node, request_set_flow);
    }


    // callback when receive response from auto-dispatch-get-flow request
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
            resp.payload = get_error_msg(node, resp.statusMessage, resp.statusCode, node.url);
        }
    }


    // callback when error caused by auto-dispatch-get-flow request
    function on_dispatch_get_error(node, resp) {
        if(resp.statusCode === 'ECONNRESET') {
            node.status({});  // clear error icon and text next to node

            // try https without authentication
            node.url = node.src_url;
            node.protocol = "https"
            var send_url = node.protocol + "://" + node.url + "/flows";
            show_console_msg("[INFO] HTTP auto-dispatch-get-flow fail, try HTTPS: " + send_url);
            send_request(node, send_url, METHOD_GET, {"Authorization": VALUE_AUTH}, null
                , function(resp) {
                    on_dispatch_get_end(node, resp);
                }
                // if error still occurs, do nothing
            );
        }
    }


    // start to get a sheet from LOCALHOST
    function on_dispatch_auto_get(node) {
        // get local flow, try http without authentication
        node.url = node.src_url;
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


    // callback when receive response from auto-dispatch-set-flow request
    function on_dispatch_set_end(node, send_url, flows, resp) {
        if(resp.statusCode === RESP_NO_CONT) {
            resp.payload = get_succ_dispatch_msg(node, resp.statusCode, send_url);
            node.send(resp);
        } else if((resp.statusCode == RESP_UNAUTH || resp.statusCode == RESP_BAD_REQ) && node.is_auth) {
            // require destination authentication
            request_invoke_token(node, function(node, hdrs) {
                // set flows with token
                send_request(node, send_url, METHOD_POST, hdrs, flows,
                    function(resp) {
                        // destroy destination token
                        request_revoke_token(node, hdrs.Authorization.substr(VALUE_AUTH.length + 1));

                        if(resp.statusCode === RESP_NO_CONT) {
                            resp.payload = get_succ_dispatch_msg(node, resp.statusCode, send_url);
                        } else {
                            resp.payload = get_error_msg(node, resp.statusMessage, resp.statusCode, send_url);
                        }

                        node.send(resp);
                    }
                    , function(resp) {
                        // destroy destination token
                        request_revoke_token(node, hdrs.Authorization.substr(VALUE_AUTH.length + 1));
                    }
                );
            });
        } else {
            resp.payload = get_error_msg(node, resp.statusMessage, resp.statusCode, send_url);
            node.send(resp);
        }
    }


    // callback when error caused by auto-dispatch-set-flow request
    function on_dispatch_set_error(node, headers, flows, resp) {
        if(resp.statusCode === 'ECONNRESET') {
            node.status({});  // clear error icon and text next to node

            // try https without authentication
            node.protocol = "https"
            var send_url = node.protocol + "://" + node.url + "/flows";
            show_console_msg("[INFO] HTTP auto-dispatch-set-flow fail, try HTTPS: " + send_url);
            send_request(node, send_url, METHOD_POST, headers, flows
                , function(resp) {
                    on_dispatch_set_end(node, send_url, flows, resp);
                }
            );
        }
    }


    // start to set a sheet to destination
    function on_dispatch_auto_set(node, resp) {
        resp.payload = sheet_prune(JSON.parse(resp.payload), node.sheet);

        if(resp.payload) {
            // get local sheet ok, try to dispatch it using http without authentication
            node.url = node.dest_url;
            node.protocol = "http";
            var send_url = node.protocol + "://" + node.url + "/flows";
            var flows = JSON.stringify(resp.payload);
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
            var info = "Sheet Not Found (" + node.sheet + ")";
            resp.payload = get_error_msg(node, info, null, null);
        }
    }


    // start to dispatch a local sheet to destination
    function init_auto_dispatch(node) {
        node.status({});  // clear node status
        on_dispatch_auto_get(node);
    }


	// The main node definition - most things happen in here
	function FlowReader(config) {
		// Create a RED node
		RED.nodes.createNode(this, config);

		// Store local copies of the node configuration (as defined in the .html)
        var node = this;
        node.protocol = config.protocol;
        node.url = config.url;
        node.is_auth = config.auth;
        node.sheet = config.sheet;

		// response to inputs
		this.on('input', function(msg) {
            node.status({});
            if(node.is_auth) {
                request_get_flow_with_token(node);
            } else {
                request_get_flow_without_token(node);
            }
        });
	}


	function FlowWriter(config) {
		// Create a RED node
		RED.nodes.createNode(this, config);

		// Store local copies of the node configuration (as defined in the .html)
        var node = this;
        node.protocol = config.protocol;
        node.url = config.url;
        node.is_auth = config.auth;

		// response to inputs
		this.on('input', function(msg) {
            node.flows = msg.payload;

            node.status({});
            if(node.is_auth) {
                request_set_flow_with_token(node);
            } else {
                request_set_flow_without_token(node);
            }
        });
	}


	function FlowCloner(config) {
		// Create a RED node
		RED.nodes.createNode(this, config);

		// Store local copies of the node configuration (as defined in the .html)
        var node = this;
        node.src_url = LOCALHOST;
        node.dest_url = config.url;
        node.is_auth = config.auth;
        node.sheet = config.sheet;
        node.once = config.once;

        // triggerred on flow deploy or NodeRed server start
        if(node.once) {
            setTimeout(function() {init_auto_dispatch(node);}, 100);
        }

		// response to inputs
		this.on('input', function(msg) {
            init_auto_dispatch(node);
        });
	}

	// register nodes
    RED.nodes.registerType("flow-reader", FlowReader, {
        credentials: {
            user: {type:"text"}
            , password: {type: "password"}
        }
    });

    RED.nodes.registerType("flow-writer", FlowWriter, {
        credentials: {
            user: {type:"text"}
            , password: {type: "password"}
        }
    });

    RED.nodes.registerType("flow-cloner", FlowCloner, {
        credentials: {
            user: {type:"text"}
            , password: {type: "password"}
        }
    });

    // triggered by FlowCloner button clicked
    RED.httpAdmin.get("/auto-clone/:id", RED.auth.needsPermission("inject.write"), function(req, res) {
        var node = RED.nodes.getNode(req.params.id);
        if (node != null) {
            try {
                init_auto_dispatch(node);
                res.send(RESP_OK);
            } catch(err) {
                res.send(RESP_INTER_ERR);
            }
        } else {
            res.send(RESP_NOT_FOUND);
        }
    });
}
