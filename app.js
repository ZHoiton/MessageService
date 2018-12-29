const express = require("express");
const body_parser = require("body-parser");
const multer = require("multer");
const upload = multer();
const app = express();

const cors = require("cors");

const cassandra = require("cassandra-driver");
const timeUuid = require("cassandra-driver").types.TimeUuid;
const client = new cassandra.Client({
    contactPoints: ["127.0.0.1:9042"],
    localDataCenter: "datacenter1",
    encoding: { useUndefinedAsUnset: true },
    keyspace: "message_service_test"
});

// for parsing application/x-www-form-urlencoded
app.use(body_parser.urlencoded({ extended: false }));

// for parsing application/json
app.use(body_parser.json());

// for parsing multipart/form-data
app.use(upload.array());

//cors to tighten up the allowed incoming requests
app.use(
    cors({
        optionsSuccessStatus: 200,
        // origin: '<gateway_service_domain>',
        methods: ["POST", "GET"],
        allowedHeaders: ["Content-Type"],
        preflightContinue: false
    })
);

const port = 3000;
const io_port = 3001;

var server = require("http").Server(app);
var io = require("socket.io")(server);

server.listen(io_port);

app.get("/", (request, response) => {
    response.send("Hello World!");
});

//dummy user stucture
// {
//     "id": 2,
//     "email": "k_volodiev@abv.bg",
//     "createdAt": "2018-12-24T10:40:06.000Z",
//     "updatedAt": "2018-12-24T10:40:06.000Z"
// }
//! when using .emit use also binary to improve performance => socket.binary(false).emit();

app.post("/conversation", (request, response) => {
    const conversation = {};
    conversation["title"] = request.body.title;
    conversation["participants"] = {};

    JSON.parse(request.body.participants).forEach(participant => {
        conversation["participants"][participant] = timeUuid.now();
    });

    conversation["image"] = request.body.image;
    conversation["last_message"] = request.body.last_message;
    conversation["last_message_timestamp"] = new Date();
    conversation["key"] = timeUuid.now();

    const conversation_db = {};
    conversation_db["query"] = "insert into conversations (key, participants_id) values(?,?)";
    conversation_db["params"] = [conversation["key"], conversation["participants"]];
    client
        .execute(conversation_db["query"], conversation_db["params"], { prepare: true })
        .then(result => {
            console.log("conversation imported");
        })
        .catch(error => {
            console.log(error);
        });
    let query = [];
    for (var participant in conversation["participants"]) {
        if (conversation["participants"].hasOwnProperty(participant)) {
            query.push({
                query:
                    "insert into user_conversations (key, conversation_key, conversation_title, image, last_message, last_message_timestamp, user_id) " +
                    "values(?,?,?,?,?,?,?)",
                params: [
                    conversation["participants"][participant],
                    conversation["key"],
                    conversation["title"],
                    conversation["image"],
                    conversation["last_message"],
                    conversation["last_message_timestamp"],
                    participant
                ]
            });
        }
    }

    client
        .batch(query, { prepare: true })
        .then(result => {
            console.log("participant imported");
            for (var participant in conversation["participants"]) {
                if (conversation["participants"].hasOwnProperty(participant)) {
                    client
                        .execute(
                            "update unseen_messages_counter set unseen_messages = unseen_messages + 0 where user_conversation_key = ?",
                            [conversation["participants"][participant]],
                            { prepare: true }
                        )
                        .then(result => {
                            console.log("counters imported");
                        })
                        .catch(error => {
                            console.log(error);
                        });
                }
            }
        })
        .catch(error => {
            console.log(error);
        });

    response.sendStatus(200);
});

app.post("/conversations/port", (request, response) => {});

io.of("/join/chat", socket => {
    const conversation_key = socket.handshake.query.conversation_key;

    const user_id = socket.handshake.query.user_id;

    console.log(`user_id:${user_id} connected to private/chat : ${conversation_key}`);

    socket.join(`chat-room-${conversation_key}`, () => {
        console.log(Object.keys(socket.rooms));
    });

    const query = "select * from messages where conversation_key = ? order by send_at desc limit 5";

    const params = [conversation_key];
    client
        .execute(query, params, { prepare: true })
        .then(result => {
            let messages = result.rows;

            // NOT needed anymore because it turns our cassandra is not that primitive...
            // messages.sort((a, b) => (a.timestamp > b.timestamp ? 1 : b.timestamp > a.timestamp ? -1 : 0));

            client
                .execute("select * from user_last_seen_message where conversation_key = ?", [conversation_key], { prepare: true })
                .then(result => {
                    const response = {
                        status: "ok",
                        code: 200,
                        messages: [],
                        data: {
                            messages,
                            last_seen_messages: result.rows
                        },
                        error: {}
                    };
                    socket.emit(`load-conversation-${conversation_key}`, response);
                })
                .catch(error => {
                    console.log(error);
                });

            //after loading the conversation broadcast an event to everyone else that the user has seen the messages

            const query = "select * from conversations where key = ?";
            const params = [conversation_key];
            client
                .execute(query, params, { prepare: true })
                .then(result => {
                    if (result.rowLength > 0 && messages.length > 0) {
                        let conversation = result.rows[0];
                        const user_conversation_key = conversation["participants_id"][user_id];

                        client
                            .execute("select * from unseen_messages_counter where user_conversation_key = ?", [user_conversation_key], {
                                prepare: true
                            })
                            .then(result => {
                                const counter_decrement = result.rows[0]["unseen_messages"];
                                client
                                    .execute(
                                        "update user_last_seen_message set conversation_key = ?, user_id = ?, last_seen_message_key = ? where user_conversation_key = ?",
                                        [conversation_key, user_id, messages[messages.length - 1]["key"], user_conversation_key],
                                        { prepare: true }
                                    )
                                    .then(result => {
                                        client
                                            .execute(
                                                "update unseen_messages_counter set unseen_messages = unseen_messages - ? where user_conversation_key = ?",
                                                [parseInt(counter_decrement), user_conversation_key],
                                                { prepare: true }
                                            )
                                            .then(result => {
                                                const response = {
                                                    status: "ok",
                                                    code: 200,
                                                    messages: [],
                                                    data: {
                                                        user: user_id,
                                                        message_key: messages[messages.length - 1]["key"]
                                                    },
                                                    error: {}
                                                };
                                                socket.to(`chat-room-${conversation_key}`).broadcast.emit("last-message-seen", response);

                                                updatePrivateMessageList(user_id);
                                                updateGlobalMessages(user_id);
                                            })
                                            .catch(error => {
                                                console.log(error);
                                            });
                                    })
                                    .catch(error => {
                                        console.log(error);
                                    });
                            })
                            .catch(error => {
                                console.log(error);
                            });
                    }
                })
                .catch(error => {
                    console.log(error);
                });
        })
        .catch(error => {
            console.log(error);
        });

    socket.on(`new-message-${conversation_key}`, message => {
        console.log("new-message-" + conversation_key);

        const query = "select * from conversations where key = ?";
        const params = [conversation_key];
        client
            .execute(query, params, { prepare: true })
            .then(result => {
                if (result.rowLength > 0) {
                    let conversation = result.rows[0];
                    sendMessage(user_id, message, conversation);
                }
            })
            .catch(error => {
                console.log(error);
            });
    });

    socket.on(`seen-last-message-${conversation_key}`, () => {
        console.log("seen-last-message-" + conversation_key);
        const query = "select * from messages where conversation_key = ? order by send_at desc limit 1";

        const params = [conversation_key];
        client.execute(query, params, { prepare: true }).then(result => {
            if (result.rowLength > 0) {
                let message = result.rows[0];
                client
                    .execute("select * from conversations where key = ? limit 1", [conversation_key], { prepare: true })
                    .then(result => {
                        if (result.rowLength > 0) {
                            const conversation = result.rows[0];
                            client
                                .execute(
                                    "update user_last_seen_message set conversation_key = ?, user_id = ?, last_seen_message_key = ? where user_conversation_key = ?",
                                    [conversation_key, user_id, message["key"], conversation["participants_id"][user_id]],
                                    { prepare: true }
                                )
                                .then(result => {
                                    const response = {
                                        status: "ok",
                                        code: 200,
                                        messages: [],
                                        data: {
                                            user_id,
                                            message_key: message["key"]
                                        },
                                        error: {}
                                    };
                                    io.of("/join/chat")
                                        .to(`chat-room-${conversation_key}`)
                                        .emit("last-message-seen", response);
                                })
                                .catch(error => {
                                    console.log(error);
                                });
                        }
                    })
                    .catch(error => {
                        console.log(error);
                    });
            }
        });
    });
});

/**
 *
 * @param {Int} sender                     - user id whihc sends the message
 * @param {Object} message                 - contains all the messages props to be submited
 * @param {props} message.body             - the text of the message
 * @param {praps} message.send_at          - the time the message was send by the user(not the one which is added in the database)
 *
 */
const sendMessage = (sender, message, conversation) => {
    let queries = [];

    //users to which the new_message event should be broadcasted
    let receivers = [];

    // assembling the queries for updating the user`s conversation
    for (var participant in conversation["participants_id"]) {
        if (conversation["participants_id"].hasOwnProperty(participant)) {
            if (parseInt(participant) === parseInt(sender)) {
                queries.push({
                    query:
                        "update user_conversations set last_message = ?, last_message_timestamp = ? where key = ? and conversation_key = ?",
                    params: [message.body, message.send_at, conversation["participants_id"][participant], conversation["key"]]
                });
            } else {
                queries.push({
                    query:
                        "update user_conversations set last_message = ?, last_message_timestamp = ? where key = ? and conversation_key = ?",
                    params: [message.body, message.send_at, conversation["participants_id"][participant], conversation["key"]]
                });
                receivers.push(participant);
            }
        }
    }

    const new_message_key = timeUuid.now();
    message["key"] = new_message_key;

    queries.push({
        query: "insert into messages (key, author_id, body, conversation_key, send_at) values(?,?,?,?,?)",
        params: [new_message_key, sender, message.body, conversation["key"], new Date(message.send_at).getTime()]
    });
    client
        .batch(queries, { prepare: true })
        .then(result => {
            let query = "update unseen_messages_counter set unseen_messages = unseen_messages + 1 where user_conversation_key in (?";
            let params = [conversation["participants_id"][receivers[0]]];
            if (receivers.length > 1) {
                for (let index = 1; index < receivers.length; index++) {
                    const receiver = conversation["participants_id"][receivers[index]];
                    query += ",?";
                    params.push(receiver);
                }
            }
            query += ")";

            client
                .execute(query, params, { prepare: true })
                .then(result => {
                    const response = {
                        status: "ok",
                        code: 200,
                        messages: ["message-send"],
                        data: {
                            sender,
                            message
                        },
                        error: {}
                    };
                    io.of("/join/chat")
                        .to(`chat-room-${conversation["key"]}`)
                        .emit("new-message", response);

                    receivers.forEach(receiver => {
                        updatePrivateMessageList(receiver);
                        updateGlobalMessages(receiver);
                    });
                })
                .catch(error => {
                    console.log(error);
                });
        })
        .catch(error => {
            console.log(error);
        });
};

//returns all the messages for the user
io.of("/private/messages").on("connection", socket => {
    const user_id = socket.handshake.query.user_id;

    console.log(`user_id:${user_id} connected to private/messages`);

    updatePrivateMessageList(user_id);
});

const updatePrivateMessageList = user_id => {
    console.log(`user_id:${user_id} updated messages-list`);
    const query = "select * from user_conversations where user_id = ? limit 10 ";
    const params = [user_id];

    client
        .execute(query, params, { prepare: true })
        .then(result => {
            if (result.rowLength > 0) {
                let conversations = result.rows;

                let query = "select * from unseen_messages_counter where user_conversation_key in (?";
                let params = [result.rows[0]["key"]];
                if (result.rowLength > 1) {
                    for (let index = 1; index < result.rowLength; index++) {
                        const conversation_key = result.rows[index]["key"];
                        query += ",?";
                        params.push(conversation_key);
                    }
                }
                query += ")";

                client
                    .execute(query, params, { prepare: true })
                    .then(result => {
                        conversations.forEach((conversation, index) => {
                            conversation["unseen_messages"] = result.rows[index]["unseen_messages"];
                        });

                        conversations.sort((a, b) =>
                            a.last_message_timestamp > b.last_message_timestamp
                                ? -1
                                : b.last_message_timestamp > a.last_message_timestamp
                                ? 1
                                : 0
                        );
                        const response = {
                            status: "ok",
                            code: 200,
                            messages: [],
                            data: {
                                conversations
                            },
                            error: {}
                        };
                        io.of("/private/messages").emit(`message-list-${user_id}`, response);
                    })
                    .catch(error => {
                        console.log(error);
                    });
            }
        })
        .catch(error => {
            console.log(error);
        });
};

//global listener for checking if there are unred messages on innitial connection
io.of("/global/messages").on("connection", global_socket => {
    const user_id = global_socket.handshake.query.user_id;

    console.log(`user_id:${user_id} connected to global/messages`);

    updateGlobalMessages(user_id);
});

/**
 * emiting an update event to a specific user
 * @param {String|Int} user_id the id of the user on which the update should be called
 */
const updateGlobalMessages = user_id => {
    console.log(`user_id:${user_id} update to global/messages`);

    const query = "select key from user_conversations where user_id = ?";
    const params = [user_id];

    client
        .execute(query, params, { prepare: true })
        .then(result => {
            if (result.rowLength > 0) {
                let query = "select * from unseen_messages_counter where user_conversation_key in (?";
                let params = [result.rows[0]["key"]];
                if (result.rowLength > 1) {
                    for (let index = 1; index < result.rowLength; index++) {
                        const conversation_key = result.rows[index]["key"];
                        query += ",?";
                        params.push(conversation_key);
                    }
                }
                query += ")";

                client
                    .execute(query, params, { prepare: true })
                    .then(result => {
                        let unseen = 0;
                        result.rows.forEach(row => {
                            if (parseInt(row["unseen_messages"]) > 0) {
                                unseen++;
                            }
                        });
                        const response = {
                            status: "ok",
                            code: 200,
                            messages: [],
                            data: {
                                unseen
                            },
                            error: {}
                        };
                        io.of("/global/messages")
                            .binary(false)
                            .emit(`unseen-messages-${user_id}`, response);
                    })
                    .catch(error => {
                        console.log(error);
                    });
            } else {
                const response = {
                    status: "ok",
                    code: 200,
                    messages: [],
                    data: {
                        unseen: result.rowLength
                    },
                    error: {}
                };
                io.of("/global/messages")
                    .binary(false)
                    .emit(`unseen-messages-${user_id}`, response);
            }
        })
        .catch(error => {
            console.log(error);
        });
};

app.listen(port, () => console.log(`Service running on 127.0.0.1:${port}!`));
