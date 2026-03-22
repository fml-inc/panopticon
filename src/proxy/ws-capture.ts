/**
 * WebSocket frame parser for capturing messages flowing through the tunnel.
 *
 * Extracts complete text messages from raw TCP data without modifying the
 * stream — the caller forwards the original bytes to the other socket and
 * feeds a copy here for inspection.
 */

export class WebSocketMessageExtractor {
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private currentOpcode = 0;

  onMessage?: (message: string) => void;

  push(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    this.drain();
  }

  private drain(): void {
    while (this.buffer.length >= 2) {
      const byte0 = this.buffer[0];
      const byte1 = this.buffer[1];
      const fin = (byte0 & 0x80) !== 0;
      const opcode = byte0 & 0x0f;
      const masked = (byte1 & 0x80) !== 0;
      let payloadLen = byte1 & 0x7f;

      let headerLen = 2;
      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        headerLen = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        payloadLen = Number(this.buffer.readBigUInt64BE(2));
        headerLen = 10;
      }

      if (masked) headerLen += 4;

      const totalLen = headerLen + payloadLen;
      if (this.buffer.length < totalLen) return;

      // Extract and optionally unmask payload
      let payload = this.buffer.subarray(headerLen, totalLen);
      if (masked) {
        const maskKey = this.buffer.subarray(headerLen - 4, headerLen);
        payload = Buffer.from(payload); // copy before mutating
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i % 4];
        }
      }

      // Handle text/binary frames and continuations
      if (opcode === 0x1 || opcode === 0x2) {
        this.currentOpcode = opcode;
        this.fragments = [payload];
      } else if (opcode === 0x0) {
        this.fragments.push(payload);
      }

      if (fin && this.fragments.length > 0 && opcode <= 0x2) {
        if (this.currentOpcode === 0x1) {
          try {
            const msg = Buffer.concat(this.fragments).toString("utf-8");
            this.onMessage?.(msg);
          } catch {
            // malformed utf-8, skip
          }
        }
        this.fragments = [];
      }

      this.buffer = this.buffer.subarray(totalLen);
    }
  }
}
