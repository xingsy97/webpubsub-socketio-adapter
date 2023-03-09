process.env.DEBUG="*";
import express from "express";
import {WebPubSubEioManager} from "../../src";
const path = require('path');

const wpsOptions = {
  hub: "eio_hub", 
  path: "/eventhandler/",
  connectionString: "Endpoint=http://localhost;Port=8080;AccessKey=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGH;Version=1.0;",
}

const eioOptions = {
  transports:['websocket'], 
  httpCompression:false, 
  pingInterval:5000
}

const app = express();
app.use(express.static(path.join(__dirname, "public").replace("build\\","")) as any);

const eioManager = new WebPubSubEioManager(app, eioOptions as any, wpsOptions);

eioManager.eioServer.on("connection", socket => {
  console.log("[SIO Server][onConnect]");
  socket.send("[From Server] hello");
  setInterval(() => { console.log(socket.readyState); }, 10000);
});

eioManager.httpServer.listen(3000);