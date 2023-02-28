process.env.DEBUG="*";
import express from "express";
import {Server as EioServer} from "G:/engine.io";
import {WebPubSubServerAdapter, eioBuild} from "../index";
const wpsOptions = {
  hub: "eio_hub", 
  path: "/eventhandler/",
  connectionString: "Endpoint=http://localhost;Port=8080;AccessKey=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGH;Version=1.0;",
}

const app = express();

const adapter = new WebPubSubServerAdapter(wpsOptions);
const eioServer = new EioServer({transports:['websocket'], wsEngine: adapter, httpCompression:false});
const httpServer = eioBuild(app, eioServer);

httpServer.listen(3000);

eioServer.on("connection", socket => {
  console.log("[server] connection")
  socket.on("connect", data => { console.log(data); })
  socket.on('message', data => { console.log(data); });
  socket.on("data", (...args) => {
    console.log(args);
    socket.send("from server")
  });
  socket.on('close', () => { console.log("[server] The connection is close"); });
  socket.send("[From Server] hello");
  socket.emit("event-on-client");
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