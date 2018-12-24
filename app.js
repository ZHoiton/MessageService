const express = require("express");
const body_parser = require("body-parser");
const multer = require("multer");
const upload = multer();
const app = express();

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

app.post("/conversations", (request, response) => {
    const query =
        "insert into conversations (key, conversation_title, last_message_timestamp, participants_id, unseen_messages) values(?,?,?,?,?)";
    const params = [timeUuid.now(), "new_conv_3", new Date(), [1, 4], { 1: false, 4: true }];
    client
        .execute(query, params, { prepare: true })
        .then(result => {
            console.log(result);
        })
        .catch(error => {
            console.log(error);
        });
});

app.get("/conversations", (request, response) => {
    const user = JSON.parse(request.body.user);
    const query = "select * from conversations where participants_id contains ? limit 10";
    const params = [user.id];
    client
        .execute(query, params, { prepare: true })
        .then(result => {
            // console.log("result",result);
            let conversations = result.rows;

            conversations.sort((a, b) =>
                a.last_message_timestamp > b.last_message_timestamp ? -1 : b.last_message_timestamp > a.last_message_timestamp ? 1 : 0
            );

            response.status(200).send({
                status: "ok",
                code: 200,
                messages: [],
                data: {
                    conversations
                },
                error: {}
            });
        })
        .catch(error => {
            console.log(error);
        });
});

app.post("/conversations/port", (request, response) => {});

io.on("connection", function(socket) {
    console.log("a user connected");

    socket.on("disconnect", function() {
        console.log("user disconnected");
    });
});

io.of("/chat").on("connection", function(socket) {
    console.log("a user connected to chat");

    socket.on("disconnect", function() {
        console.log("user disconnected to chat");
    });
});

//global listener for checking if there are unred messages
io.of("/global/messages").on("connection", socket => {
    const user_id = socket.handshake.query.user_id;
    const query = "select * from conversations where unseen_messages[?] = true";
    const params = [user_id];
    client
        .execute(query, params, { prepare: true })
        .then(result => {
            const response = {
                status: "ok",
                code: 200,
                messages: [],
                data: {
                    unseen: result.rowLength
                },
                error: {}
            };
            socket.emit("unseen", response);
        })
        .catch(error => {
            console.log(error);
        });
});

app.listen(port, () => console.log(`Service running on 127.0.0.1:${port}!`));
