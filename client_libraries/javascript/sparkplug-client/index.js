/**
 * Copyright (c) 2016-2017 Cirrus Link Solutions
 *
 *  All rights reserved. This program and the accompanying materials
 *  are made available under the terms of the Eclipse Public License v1.0
 *  which accompanies this distribution, and is available at
 *  http://www.eclipse.org/legal/epl-v10.html
 *
 * Contributors:
 *   Cirrus Link Solutions
 */

var mqtt = require('mqtt'),
    sparkplug = require('sparkplug-payload'),
    sparkplugbpayload = sparkplug.get("spBv1.0"),
    events = require('events'),
    util = require("util"),
    pako = require('pako'),
    logger = require('winston');

var compressed = "SPBV1.0_COMPRESSED";

logger.level = 'warn';

var getRequiredProperty = function(config, propName) {
    if (config[propName] !== undefined) {
        return config[propName];
    }
    throw new Error("Missing required configuration property '" + propName + "'");
};

var getProperty = function(config, propName, defaultValue) {
    if (config[propName] !== undefined) {
        return config[propName];
    } else {
        return defaultValue;
    }
};

/*
 * Sparkplug Client
 */
function SparkplugClient(config) {
    var versionB = "spBv1.0",
        serverUrl = getRequiredProperty(config, "serverUrl"),
        username = getRequiredProperty(config, "username"),
        password = getRequiredProperty(config, "password"),
        groupId = getRequiredProperty(config, "groupId"),
        edgeNode = getRequiredProperty(config, "edgeNode"),
        clientId = getRequiredProperty(config, "clientId"),
        publishDeath = getProperty(config, "publishDeath", false),
        version = getProperty(config, "version", versionB),
        bdSeq = 0,
        seq = 0,
        devices = [],
        client = null,
        connecting = false,
        connected = false,
        type_int32 = 7,
        type_boolean = 11,
        type_string = 12,

    // Increments a sequence number
    incrementSeqNum = function() {
        if (seq == 256) {
            seq = 0;
        }
        return seq++;
    },

    encodePayload = function(payload) {
        return sparkplugbpayload.encodePayload(payload);
    },

    decodePayload = function(payload) {
        return sparkplugbpayload.decodePayload(payload);
    },

    addSeqNumber = function(payload) {
        payload.seq = incrementSeqNum();
    },

    // Get DEATH payload
    getDeathPayload = function() {
        var payload = {
                "timestamp" : new Date().getTime()
            },
            metric = [ {
                "name" : "bdSeq", 
                "value" : bdSeq, 
                "type" : "uint64"
            } ];
        payload.metrics = metric;
        return payload;
    },

    // Publishes DEATH certificates for the edge node
    publishNDeath = function(client) {
        var payload, topic;

        // Publish DEATH certificate for edge node
        logger.info("Publishing Edge Node Death");
        payload = getDeathPayload();
        topic = version + "/" + groupId + "/NDEATH/" + edgeNode;
        client.publish(topic, encodePayload(payload));
        messageAlert("published", topic, payload);
    },

    // Logs a message alert to the console
    messageAlert = function(alert, topic, payload) {
        logger.debug("Message " + alert);
        logger.debug(" topic: " + topic);
        logger.debug(" payload: " + JSON.stringify(payload));
    },

    compressPayload = function(payload, options) {
        var algorithm = null,
            compressedPayload,
            resultPayload = {
                "uuid" : compressed
            };

        logger.debug("Compressing payload " + JSON.stringify(options));

        // See if any options have been set
        if (options !== undefined && options !== null) {
            // Check algorithm
            if (options['algorithm']) {
                algorithm = options['algorithm'];
            }
        }

        if (algorithm === null || algorithm.toUpperCase() === "DEFLATE") {
            logger.debug("Compressing with DEFLATE!");
            resultPayload.body = pako.deflate(payload);
        } else if (algorithm.toUpperCase() === "GZIP") {
            logger.debug("Compressing with GZIP");
            resultPayload.body = pako.gzip(payload);
        } else {
            throw new Error("Unknown or unsupported algorithm " + algorithm);
        }

        // Create and add the algorithm metric if is has been specified in the options
        if (algorithm !== null) {
            resultPayload.metrics = [ {
                "name" : "algorithm", 
                "value" : algorithm.toUpperCase(), 
                "type" : "string"
            } ];
        }

        return resultPayload;
    },

    decompressPayload = function(payload) {
        var metrics = payload.metrics,
            algorithm = null;

        logger.debug("Decompressing payload");

        if (metrics !== undefined && metrics !== null) {
            for (var i = 0; i < metrics.length; i++) {
                if (metrics[i].name === "algorithm") {
                    algorithm = metrics[i].value;
                }
            }
        }

        if (algorithm === null || algorithm.toUpperCase() === "DEFLATE") {
            logger.debug("Decompressing with DEFLATE!");
            return pako.inflate(payload.body);
        } else if (algorithm.toUpperCase() === "GZIP") {
            logger.debug("Decompressing with GZIP");
            return pako.ungzip(payload.body);
        } else {
            throw new Error("Unknown or unsupported algorithm " + algorithm);
        }

    },

    maybeCompressPayload = function(payload, options) {
        if (options !== undefined && options !== null && options.compress) {
            // Compress the payload
            return compressPayload(encodePayload(payload), options);
        } else {
            // Don't compress the payload
            return payload;
        }
    },

    maybeDecompressPayload = function(payload) {
        if (payload.uuid !== undefined && payload.uuid === compressed) {
            // Decompress the payload
            return decodePayload(decompressPayload(payload));
        } else {
            // The payload is not compressed
            return payload;
        }
    };

    events.EventEmitter.call(this);

    // Publishes Node BIRTH certificates for the edge node
    this.publishNodeBirth = function(payload, options) {
        var topic = version + "/" + groupId + "/NBIRTH/" + edgeNode;
        // Reset sequence number
        seq = 0;
        // Add seq number
        addSeqNumber(payload);
        // Add bdSeq number
        var metrics = payload.metrics
        if (metrics !== undefined && metrics !== null) {
            metrics.push({
                "name" : "bdSeq",
                "type" : "uint64", 
                "value" : bdSeq
            });
        }

        // Publish BIRTH certificate for edge node
        logger.info("Publishing Edge Node Birth");
        var p = maybeCompressPayload(payload, options);
        client.publish(topic, encodePayload(p));
        messageAlert("published", topic, p);
    };

    // Publishes Node Data messages for the edge node
    this.publishNodeData = function(payload, options) {
        var topic = version + "/" + groupId + "/NDATA/" + edgeNode;
        // Add seq number
        addSeqNumber(payload);
        // Publish
        logger.info("Publishing NDATA");
        client.publish(topic, encodePayload(maybeCompressPayload(payload, options)));
        messageAlert("published", topic, payload);
    };

    // Publishes Node BIRTH certificates for the edge node
    this.publishDeviceData = function(deviceId, payload, options) {
        var topic = version + "/" + groupId + "/DDATA/" + edgeNode + "/" + deviceId;
        // Add seq number
        addSeqNumber(payload);
        // Publish
        logger.info("Publishing DDATA for device " + deviceId);
        client.publish(topic, encodePayload(maybeCompressPayload(payload, options)));
        messageAlert("published", topic, payload);
    };

    // Publishes Node BIRTH certificates for the edge node
    this.publishDeviceBirth = function(deviceId, payload, options) {
        var topic = version + "/" + groupId + "/DBIRTH/" + edgeNode + "/" + deviceId;
        // Add seq number
        addSeqNumber(payload);
        // Publish
        logger.info("Publishing DBIRTH for device " + deviceId);
        var p = maybeCompressPayload(payload, options);
        client.publish(topic, encodePayload(p));
        messageAlert("published", topic, p);
    };

    // Publishes Node BIRTH certificates for the edge node
    this.publishDeviceDeath = function(deviceId, payload) {
        var topic = version + "/" + groupId + "/DDEATH/" + edgeNode + "/" + deviceId,
            options = {};
        // Add seq number
        addSeqNumber(payload);
        // Publish
        logger.info("Publishing DDEATH for device " + deviceId);
        client.publish(topic, encodePayload(maybeCompressPayload(payload, options)));
        messageAlert("published", topic, payload);
    };

    this.stop = function() {
        logger.debug("publishDeath: " + publishDeath);
        if (publishDeath) {
            // Publish the DEATH certificate
            publishNDeath(client);
        }
        client.end();
    };

    // Configures and connects the client
    return (function(sparkplugClient) {
        var deathPayload = getDeathPayload(),
            // Client connection options
            clientOptions = {
                "clientId" : clientId,
                "clean" : true,
                "keepalive" : 5,
                "reschedulePings" : false,
                "connectionTimeout" : 30,
                "username" : username,
                "password" : password,
                "will" : {
                    "topic" : version + "/" + groupId + "/NDEATH/" + edgeNode,
                    "payload" : encodePayload(deathPayload),
                    "qos" : 0,
                    "retain" : false
                }
            };

        // Connect to the MQTT server
        sparkplugClient.connecting = true;
        logger.debug("Attempting to connect: " + serverUrl);
        logger.debug("              options: " + JSON.stringify(clientOptions));
        client = mqtt.connect(serverUrl, clientOptions);
        logger.debug("Finished attempting to connect");

        /*
         * 'connect' handler
         */
        client.on('connect', function () {
            logger.info("Client has connected");
            sparkplugClient.connecting = false;
            sparkplugClient.connected = true;
            sparkplugClient.emit("connect");

            // Subscribe to control/command messages for both the edge node and the attached devices
            logger.info("Subscribing to control/command messages for both the edge node and the attached devices");
            client.subscribe(version + "/" + groupId + "/NCMD/" + edgeNode + "/#", { "qos" : 0 });
            client.subscribe(version + "/" + groupId + "/DCMD/" + edgeNode + "/#", { "qos" : 0 });

            // Emit the "birth" event to notify the application to send a births
            sparkplugClient.emit("birth");
        });

        /*
         * 'error' handler
         */
        client.on('error', function(error) {
            if (sparkplugClient.connecting) {
                sparkplugClient.emit("error", error);
                client.end();
            }
        });

        /*
         * 'close' handler
         */
        client.on('close', function() {
            if (sparkplugClient.connected) {
                sparkplugClient.connected = false;
                sparkplugClient.emit("close");
            }
        });

        /*
         * 'reconnect' handler
         */
        client.on("reconnect", function() {
            sparkplugClient.emit("reconnect");
        });

        /*
         * 'reconnect' handler
         */
        client.on("offline", function() {
            sparkplugClient.emit("offline");
        });

        /*
         * 'packetsend' handler
         */
        client.on("packetsend", function(packet) {
            logger.debug("packetsend: " + packet.cmd);
        });

        /*
         * 'packetreceive' handler
         */
        client.on("packetreceive", function(packet) {
            logger.debug("packetreceive: " + packet.cmd);
        });

        /*
         * 'message' handler
         */
        client.on('message', function (topic, message) {
            var payload = maybeDecompressPayload(decodePayload(message)),
                timestamp = payload.timestamp,
                splitTopic,
                metrics;

            messageAlert("arrived", topic, payload);

            // Split the topic up into tokens
            splitTopic = topic.split("/");
            if (splitTopic[0] === version
                    && splitTopic[1] === groupId
                    && splitTopic[2] === "NCMD"
                    && splitTopic[3] === edgeNode) {
                // Emit the "command" event
                sparkplugClient.emit("ncmd", payload);
            } else if (splitTopic[0] === version
                    && splitTopic[1] === groupId
                    && splitTopic[2] === "DCMD"
                    && splitTopic[3] === edgeNode) {
                // Emit the "command" event for the given deviceId
                sparkplugClient.emit("dcmd", splitTopic[4], payload);
            } else {
                logger.info("Message received on unknown topic " + topic);
            }
        });

        return sparkplugClient;
    }(this));
};

util.inherits(SparkplugClient, events.EventEmitter);

exports.newClient = function(config) {
    return new SparkplugClient(config);
};
