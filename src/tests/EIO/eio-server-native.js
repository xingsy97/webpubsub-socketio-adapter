const engine = require("G:/engine.io");
// const express = require("express");

// const app = express();

const server = engine.listen(3000, {
  transports:['websocket'], 
  cors: {origin:"*"},
  pingInterval:3000
}, null);

// server.listen(3000);
// app.listen(3000);

server.on("connection", socket => {
  console.log("[server] connection")
  socket.on('message', data => { console.log("onMessage", data); });
  socket.on("data", (...args) => {
    console.log("onData", args);
  });
  socket.on('close', () => { console.log("server: close"); });
  socket.send("[From Server][socket.send] hello");
  socket.emit("event-on-client")
});