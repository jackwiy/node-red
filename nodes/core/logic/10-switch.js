/**
 * Copyright JS Foundation and other contributors, http://js.foundation
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

    var operators = {
        'eq': function(a, b) { return a == b; },
        'neq': function(a, b) { return a != b; },
        'lt': function(a, b) { return a < b; },
        'lte': function(a, b) { return a <= b; },
        'gt': function(a, b) { return a > b; },
        'gte': function(a, b) { return a >= b; },
        'btwn': function(a, b, c) { return a >= b && a <= c; },
        'cont': function(a, b) { return (a + "").indexOf(b) != -1; },
        'regex': function(a, b, c, d) { return (a + "").match(new RegExp(b,d?'i':'')); },
        'true': function(a) { return a === true; },
        'false': function(a) { return a === false; },
        'null': function(a) { return (typeof a == "undefined" || a === null); },
        'nnull': function(a) { return (typeof a != "undefined" && a !== null); },
        'istype': function(a, b) {
            if (b === "array") { return Array.isArray(a); }
            else if (b === "buffer") { return Buffer.isBuffer(a); }
            else if (b === "json") {
                try { JSON.parse(a); return true; }   // or maybe ??? a !== null; }
                catch(e) { return false;}
            }
            else if (b === "null") { return a === null; }
            else { return typeof a === b && !Array.isArray(a) && !Buffer.isBuffer(a) && a !== null; }
        },
        'head': function(a, b, c, d, parts) {
            var count = Number(b);
            return (parts.index < count);
        },
        'tail': function(a, b, c, d, parts) {
            var count = Number(b);
            return (parts.count -count <= parts.index);
        },
        'index': function(a, b, c, d, parts) {
            var min = Number(b);
            var max = Number(c);
            var index = parts.index;
            return ((min <= index) && (index <= max));
        },
        'jsonata_exp': function(a, b) { return (b === true); },
        'else': function(a) { return a === true; }
    };

    var _maxKeptCount;

    function getMaxKeptCount() {
        if (_maxKeptCount === undefined) {
            var name = "nodeMessageBufferMaxLength";
            if (RED.settings.hasOwnProperty(name)) {
                _maxKeptCount = RED.settings[name];
            }
            else {
                _maxKeptCount = 0;
            }
        }
        return _maxKeptCount;
    }

    function getProperty(node,msg) {
        return new Promise((resolve,reject) => {
            if (node.propertyType === 'jsonata') {
                try {
                    resolve(RED.util.evaluateJSONataExpression(node.property,msg));
                } catch(err) {
                    // TODO: proper invalid expr message
                    reject(err);
                }
            } else {
                resolve(RED.util.evaluateNodeProperty(node.property,node.propertyType,node,msg));
            }
        });
    }

    function getV1(node,msg,rule,hasParts) {
        return new Promise( (resolve,reject) => {
            if (rule.vt === 'prev') {
                resolve(node.previousValue);
            } else if (rule.vt === 'jsonata') {
                try {
                    var exp = rule.v;
                    if (rule.t === 'jsonata_exp') {
                        if (hasParts) {
                            exp.assign("I", msg.parts.index);
                            exp.assign("N", msg.parts.count);
                        }
                    }
                    resolve(RED.util.evaluateJSONataExpression(exp,msg));
                } catch(err) {
                    reject(RED._("switch.errors.invalid-expr",{error:err.message}));
                }
            } else if (rule.vt === 'json') {
                resolve("json");
            } else if (rule.vt === 'null') {
                resolve("null");
            } else {
                RED.util.evaluateNodeProperty(rule.v,rule.vt,node,msg, function(err,value) {
                    if (err) {
                        resolve(undefined);
                    } else {
                        resolve(value);
                    }
                });
            }
        });
    }

    function getV2(node,msg,rule) {
        return new Promise((resolve,reject) => {
            var v2 = rule.v2;
            if (rule.v2t === 'prev') {
                resolve(node.previousValue);
            } else if (rule.v2t === 'jsonata') {
                try {
                    resolve(RED.util.evaluateJSONataExpression(rule.v2,msg));
                } catch(err) {
                    reject(RED._("switch.errors.invalid-expr",{error:err.message}));
                }
            } else if (typeof v2 !== 'undefined') {
                RED.util.evaluateNodeProperty(rule.v2,rule.v2t,node,msg, function(err,value) {
                    if (err) {
                        resolve(undefined);
                    } else {
                        resolve(value);
                    }
                });
            } else {
                resolve(v2);
            }
        })
    }



    function SwitchNode(n) {
        RED.nodes.createNode(this, n);
        this.rules = n.rules || [];
        this.property = n.property;
        this.propertyType = n.propertyType || "msg";

        if (this.propertyType === 'jsonata') {
            try {
                this.property = RED.util.prepareJSONataExpression(this.property,this);
            } catch(err) {
                this.error(RED._("switch.errors.invalid-expr",{error:err.message}));
                return;
            }
        }

        this.checkall = n.checkall || "true";
        this.previousValue = null;
        var node = this;
        var valid = true;
        var repair = n.repair;
        var needsCount = repair;
        for (var i=0; i<this.rules.length; i+=1) {
            var rule = this.rules[i];
            needsCount = needsCount || ((rule.t === "tail") || (rule.t === "jsonata_exp"));
            if (!rule.vt) {
                if (!isNaN(Number(rule.v))) {
                    rule.vt = 'num';
                } else {
                    rule.vt = 'str';
                }
            }
            if (rule.vt === 'num') {
                if (!isNaN(Number(rule.v))) {
                    rule.v = Number(rule.v);
                }
            } else if (rule.vt === "jsonata") {
                try {
                    rule.v = RED.util.prepareJSONataExpression(rule.v,node);
                } catch(err) {
                    this.error(RED._("switch.errors.invalid-expr",{error:err.message}));
                    valid = false;
                }
            }
            if (typeof rule.v2 !== 'undefined') {
                if (!rule.v2t) {
                    if (!isNaN(Number(rule.v2))) {
                        rule.v2t = 'num';
                    } else {
                        rule.v2t = 'str';
                    }
                }
                if (rule.v2t === 'num') {
                    rule.v2 = Number(rule.v2);
                } else if (rule.v2t === 'jsonata') {
                    try {
                        rule.v2 = RED.util.prepareJSONataExpression(rule.v2,node);
                    } catch(err) {
                        this.error(RED._("switch.errors.invalid-expr",{error:err.message}));
                        valid = false;
                    }
                }
            }
        }

        if (!valid) {
            return;
        }

        var pendingCount = 0;
        var pendingId = 0;
        var pendingIn = {};
        var pendingOut = {};
        var received = {};

        function addMessageToGroup(id, msg, parts) {
            if (!(id in pendingIn)) {
                pendingIn[id] = {
                    count: undefined,
                    msgs: [],
                    seq_no: pendingId++
                };
            }
            var group = pendingIn[id];
            group.msgs.push(msg);
            pendingCount++;
            var max_msgs = getMaxKeptCount();
            if ((max_msgs > 0) && (pendingCount > max_msgs)) {
                clearPending();
                node.error(RED._("switch.errors.too-many"), msg);
            }
            if (parts.hasOwnProperty("count")) {
                group.count = parts.count;
            }
            return group;
        }


        function addMessageToPending(msg) {
            var parts = msg.parts;
            if (parts.hasOwnProperty("id") &&
                parts.hasOwnProperty("index")) {
                var group = addMessageToGroup(parts.id, msg, parts);
                var msgs = group.msgs;
                var count = group.count;
                if (count === msgs.length) {
                    for (var i = 0; i < msgs.length; i++) {
                        var msg = msgs[i];
                        msg.parts.count = count;
                        processMessage(msg, false);
                    }
                    pendingCount -= group.msgs.length;
                    delete pendingIn[parts.id];
                }
                return true;
            }
            return false;
        }

        function sendGroup(onwards, port_count) {
            var counts = new Array(port_count).fill(0);
            for (var i = 0; i < onwards.length; i++) {
                var onward = onwards[i];
                for (var j = 0; j < port_count; j++) {
                    counts[j] += (onward[j] !== null) ? 1 : 0
                }
            }
            var ids = new Array(port_count);
            for (var j = 0; j < port_count; j++) {
                ids[j] = RED.util.generateId();
            }
            var ports = new Array(port_count);
            var indexes = new Array(port_count).fill(0);
            for (var i = 0; i < onwards.length; i++) {
                var onward = onwards[i];
                for (var j = 0; j < port_count; j++) {
                    var msg = onward[j];
                    if (msg) {
                        var new_msg = RED.util.cloneMessage(msg);
                        var parts = new_msg.parts;
                        parts.id = ids[j];
                        parts.index = indexes[j];
                        parts.count = counts[j];
                        ports[j] = new_msg;
                        indexes[j]++;
                    }
                    else {
                        ports[j] = null;
                    }
                }
                node.send(ports);
            }
        }

        function sendGroupMessages(onward, msg) {
            var parts = msg.parts;
            var gid = parts.id;
            received[gid] = ((gid in received) ? received[gid] : 0) +1;
            var send_ok = (received[gid] === parts.count);

            if (!(gid in pendingOut)) {
                pendingOut[gid] = {
                    onwards: []
                };
            }
            var group = pendingOut[gid];
            var onwards = group.onwards;
            onwards.push(onward);
            pendingCount++;
            if (send_ok) {
                sendGroup(onwards, onward.length, msg);
                pendingCount -= onward.length;
                delete pendingOut[gid];
                delete received[gid];
            }
            var max_msgs = getMaxKeptCount();
            if ((max_msgs > 0) && (pendingCount > max_msgs)) {
                clearPending();
                node.error(RED._("switch.errors.too-many"), msg);
            }
        }



        function processMessage(msg, checkParts) {
            var hasParts = msg.hasOwnProperty("parts") &&
                            msg.parts.hasOwnProperty("id") &&
                            msg.parts.hasOwnProperty("index");

            if (needsCount && checkParts && hasParts &&
                addMessageToPending(msg)) {
                return;
            }
            var onward = [];
            try {
                var prop;

                // getProperty
                if (node.propertyType === 'jsonata') {
                    prop = RED.util.evaluateJSONataExpression(node.property,msg);
                } else {
                    prop = RED.util.evaluateNodeProperty(node.property,node.propertyType,node,msg);
                }
                // end getProperty

                var elseflag = true;
                for (var i=0; i<node.rules.length; i+=1) {
                    var rule = node.rules[i];
                    var test = prop;
                    var v1,v2;

                    //// getV1
                    if (rule.vt === 'prev') {
                        v1 = node.previousValue;
                    } else if (rule.vt === 'jsonata') {
                        try {
                            var exp = rule.v;
                            if (rule.t === 'jsonata_exp') {
                                if (hasParts) {
                                    exp.assign("I", msg.parts.index);
                                    exp.assign("N", msg.parts.count);
                                }
                            }
                            v1 = RED.util.evaluateJSONataExpression(exp,msg);
                        } catch(err) {
                            node.error(RED._("switch.errors.invalid-expr",{error:err.message}));
                            return;
                        }
                    } else if (rule.vt === 'json') {
                        v1 = "json";
                    } else if (rule.vt === 'null') {
                        v1 = "null";
                    } else {
                        try {
                            v1 = RED.util.evaluateNodeProperty(rule.v,rule.vt,node,msg);
                        } catch(err) {
                            v1 = undefined;
                        }
                    }
                    //// end getV1

                    //// getV2
                    v2 = rule.v2;
                    if (rule.v2t === 'prev') {
                        v2 = node.previousValue;
                    } else if (rule.v2t === 'jsonata') {
                        try {
                            v2 = RED.util.evaluateJSONataExpression(rule.v2,msg);
                        } catch(err) {
                            node.error(RED._("switch.errors.invalid-expr",{error:err.message}));
                            return;
                        }
                    } else if (typeof v2 !== 'undefined') {
                        try {
                            v2 = RED.util.evaluateNodeProperty(rule.v2,rule.v2t,node,msg);
                        } catch(err) {
                            v2 = undefined;
                        }
                    }
                    //// end getV2


                    if (rule.t == "else") { test = elseflag; elseflag = true; }
                    if (operators[rule.t](test,v1,v2,rule.case,msg.parts)) {
                        onward.push(msg);
                        elseflag = false;
                        if (node.checkall == "false") { break; }
                    } else {
                        onward.push(null);
                    }
                }
                node.previousValue = prop;
                if (!repair || !hasParts) {
                    node.send(onward);
                }
                else {
                    sendGroupMessages(onward, msg);
                }
            } catch(err) {
                node.warn(err);
            }
        }

        function clearPending() {
            pendingCount = 0;
            pendingId = 0;
            pendingIn = {};
            pendingOut = {};
            received = {};
        }

        this.on('input', function(msg) {
            processMessage(msg, true);
        });

        this.on('close', function() {
            clearPending();
        });
    }

    RED.nodes.registerType("switch", SwitchNode);
}
