process.env.DEBUG="*";
import express from "express";
import {Server as EioServer} from "G:/engine.io";
import {WebPubSubServerAdapter, eioBuild} from "../../src";
const path = require('path');

const wpsOptions = {
  hub: "eio_hub", 
  path: "/eventhandler/",
  connectionString: "Endpoint=http://localhost;Port=8080;AccessKey=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGH;Version=1.0;",
}
const adapter = new WebPubSubServerAdapter(wpsOptions);

const eioOptions = {
  transports:['websocket'], 
  wsEngine: adapter, 
  httpCompression:false, 
  pingInterval:5000
}

const app = express();
app.use(express.static(path.join(__dirname, "public").replace("build\\","")) as any);

const eioServer = new EioServer(eioOptions as any);
const httpServer = eioBuild(app, eioServer, wpsOptions);

eioServer.on("connection", socket => {
  console.log("[SIO Server][onConnect]");
  socket.send("[From Server] hello");
  setInterval(() => { console.log(socket.readyState); }, 10000);
});

httpServer.listen(3000);