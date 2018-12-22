const express = require("express");
const app = express();
const port = 3000;

app.get("/", (request, response) => {
    response.send("Hello World!");
});

app.listen(port, () => console.log(`Service running on 127.0.0.1:${port}!`));
