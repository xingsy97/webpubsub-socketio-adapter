process.env.DEBUG="*";
import express from "express";
import {Server as EioServer} from "G:/engine.io";
import {WebPubSubServerAdapter, eioBuild} from "../index";
import { EventEmitter } from "events";
const wpsOptions = {
  hub: "eio_hub", 
  path: "/eventhandler/",
  connectionString: "Endpoint=http://localhost;Port=8080;AccessKey=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGH;Version=1.0;",
}

const app = express();

const adapter = new WebPubSubServerAdapter(wpsOptions);
const eioServer = new EioServer({transports:['websocket'], wsEngine: adapter, httpCompression:false, pingTimeout:1000000, pingInterval:60000});
const httpServer = eioBuild(app, eioServer);

httpServer.listen(3000);

// eioServer.addListener

eioServer.addListener("connection", socket => {
  (socket.server.ws as any).putSocketInfo(socket.id, socket);
  console.log("[server] connection")
  // socket.on("connect", data => { console.log(data); })
  // socket.on('message', data => { console.log(data); });
  // socket.on("data", (...args) => {
  //   console.log(args);
  //   socket.send("from server")
  // });
  // socket.on('close', () => { console.log("[server] The connection is close"); });
  // socket.send("[From Server] hello");
  setInterval(() => { console.log(socket.readyState); }, 10000);
});


// eioServer.use((req, res, next) => {
//   if (req.method == "OPTIONS") {
//     res.setHeader("WebHook-Allowed-Origin", '*');
//     res.statusCode=200;
//     res.end();
//   }
//   else next();
// });
// app.use(cors({origin:'*'}))
// app.use((req, res, next) => {
// });
// const server = EioAttach(httpServer, getEioOptions(wpsOptions, httpServer, app));