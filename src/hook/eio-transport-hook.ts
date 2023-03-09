// Source: lib\transports\websocket.ts:63
function hookedTransportWebSocketSend(packets: any) {
    this.writable = false;

    for (let i = 0; i < packets.length; i++) {
        const packet = packets[i];
        const isLast = i + 1 === packets.length;

        // always creates a new object since ws modifies it
        const opts: { compress?: boolean } = {};
        if (packet.options) {
            opts.compress = packet.options.compress;
        }

        const onSent = (err: Error) => {
            if (err) {
                return this.onError("write error", err.stack);
            } else if (isLast) {
                this.writable = true;
                this.emit("drain");
            }
        };

        const send = async (data) => {
            if (this.perMessageDeflate) {
            const len =
                "string" === typeof data ? Buffer.byteLength(data) : data.length;
            if (len < this.perMessageDeflate.threshold) {
                opts.compress = false;
            }
            }
            // debug('writing "%s"', data);
            // Native code uses callback: this.socket.send(data, opts, onSent);
            try {
                await this.webPubSubContext.sendText(data);
            } catch (err) {
                this.onError("write error", err.stack);
                return ;
            }
            if (isLast) {
                this.writable = true;
                this.emit("drain");
            }
        };

        if (packet.options && typeof packet.options.wsPreEncoded === "string") {
            send(packet.options.wsPreEncoded);
        } else if (this._canSendPreEncodedFrame(packet)) {
            // the WebSocket frame was computed with WebSocket.Sender.frame()
            // see https://github.com/websockets/ws/issues/617#issuecomment-283002469
            this.socket._sender.sendFrame(packet.options.wsPreEncodedFrame, onSent);
        } else {
            this.parser.encodePacket(packet, this.supportsBinary, send);
        }
    }
}

export {hookedTransportWebSocketSend}