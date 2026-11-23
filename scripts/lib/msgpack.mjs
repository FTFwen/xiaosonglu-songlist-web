// Minimal MessagePack codec (no external dependency).
// The danmakus.com archive API returns MessagePack-framed arrays:
//   [channel, live, extra] where extra = [baseTimestamp, actors, emoticons, records].
// Only the subset of MessagePack that this API emits is implemented, but the
// decoder is strict: unknown type bytes throw instead of silently misreading.

class Decoder {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = 0;
  }

  remaining() {
    return this.bytes.length - this.offset;
  }

  need(count) {
    if (this.offset + count > this.bytes.length) {
      throw new Error(`MessagePack payload ended early at offset ${this.offset}`);
    }
  }

  uint8() {
    this.need(1);
    return this.bytes[this.offset++];
  }

  view16() {
    this.need(2);
    const value = this.view.getUint16(this.offset);
    this.offset += 2;
    return value;
  }

  view32() {
    this.need(4);
    const value = this.view.getUint32(this.offset);
    this.offset += 4;
    return value;
  }

  bigInt64() {
    this.need(8);
    const value = this.view.getBigInt64(this.offset);
    this.offset += 8;
    return value;
  }

  uint64() {
    this.need(8);
    const value = this.view.getBigUint64(this.offset);
    this.offset += 8;
    return value;
  }

  decodeString(length) {
    this.need(length);
    const text = new TextDecoder('utf-8').decode(this.bytes.subarray(this.offset, this.offset + length));
    this.offset += length;
    return text;
  }

  decodeArray(length) {
    const out = new Array(length);
    for (let index = 0; index < length; index += 1) out[index] = this.read();
    return out;
  }

  decodeMap(length) {
    const out = {};
    for (let index = 0; index < length; index += 1) {
      const key = this.read();
      out[typeof key === 'string' ? key : String(key)] = this.read();
    }
    return out;
  }

  decodeBinary(length) {
    this.need(length);
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  decodeExtension(length) {
    this.uint8(); // extension type marker
    return this.decodeBinary(length);
  }

  read() {
    const type = this.uint8();
    if (type <= 0x7f) return type; // positive fixint
    if (type >= 0xe0) return type - 0x100; // negative fixint
    if (type >= 0x80 && type <= 0x8f) return this.decodeMap(type & 0x0f); // fixmap
    if (type >= 0x90 && type <= 0x9f) return this.decodeArray(type & 0x0f); // fixarray
    if (type >= 0xa0 && type <= 0xbf) return this.decodeString(type & 0x1f); // fixstr
    switch (type) {
      case 0xc0: return null;
      case 0xc1: throw new Error('MessagePack payload contains a reserved 0xc1 byte');
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return this.decodeBinary(this.uint8());
      case 0xc5: return this.decodeBinary(this.view16());
      case 0xc6: return this.decodeBinary(this.view32());
      case 0xc7: return this.decodeExtension(this.uint8());
      case 0xc8: return this.decodeExtension(this.view16());
      case 0xc9: return this.decodeExtension(this.view32());
      case 0xca: { const value = this.view.getFloat32(this.offset); this.offset += 4; return value; }
      case 0xcb: { const value = this.view.getFloat64(this.offset); this.offset += 8; return value; }
      case 0xcc: return this.uint8();
      case 0xcd: return this.view16();
      case 0xce: return this.view32();
      case 0xcf: {
        const value = this.uint64();
        return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
      }
      case 0xd0: { this.need(1); const value = this.view.getInt8(this.offset); this.offset += 1; return value; }
      case 0xd1: { this.need(2); const value = this.view.getInt16(this.offset); this.offset += 2; return value; }
      case 0xd2: { this.need(4); const value = this.view.getInt32(this.offset); this.offset += 4; return value; }
      case 0xd3: {
        const value = this.bigInt64();
        return value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value;
      }
      case 0xd4: return this.decodeExtension(1);
      case 0xd5: return this.decodeExtension(2);
      case 0xd6: return this.decodeExtension(4);
      case 0xd7: return this.decodeExtension(8);
      case 0xd8: return this.decodeExtension(16);
      case 0xd9: return this.decodeString(this.uint8());
      case 0xda: return this.decodeString(this.view16());
      case 0xdb: return this.decodeString(this.view32());
      case 0xdc: return this.decodeArray(this.view16());
      case 0xdd: return this.decodeArray(this.view32());
      case 0xde: return this.decodeMap(this.view16());
      case 0xdf: return this.decodeMap(this.view32());
      default:
        throw new Error(`Unsupported MessagePack type byte 0x${type.toString(16)} at offset ${this.offset - 1}`);
    }
  }
}

export function decodeMsgpack(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const decoder = new Decoder(bytes);
  const value = decoder.read();
  if (decoder.remaining() !== 0) {
    throw new Error(`MessagePack payload has ${decoder.remaining()} trailing bytes`);
  }
  return value;
}

function encodeHeader(out, length) {
  if (length < 0x100) out.push(0xd9, length);
  else if (length < 0x10000) out.push(0xda, length >> 8, length & 0xff);
  else out.push(0xdb, (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff);
}

export function encodeMsgpack(value) {
  const out = [];
  const write = item => {
    if (item === null || item === undefined) {
      out.push(0xc0);
      return;
    }
    if (item === true) {
      out.push(0xc3);
      return;
    }
    if (item === false) {
      out.push(0xc2);
      return;
    }
    if (typeof item === 'number') {
      if (Number.isInteger(item)) {
        if (item >= 0 && item <= 0x7f) out.push(item);
        else if (item < 0 && item >= -32) out.push(item & 0xff);
        else if (item >= 0 && item <= 0xff) out.push(0xcc, item);
        else if (item >= 0 && item <= 0xffff) out.push(0xcd, item >> 8, item & 0xff);
        else if (item >= 0 && item <= 0xffffffff) out.push(0xce, (item >>> 24) & 0xff, (item >>> 16) & 0xff, (item >>> 8) & 0xff, item & 0xff);
        else if (item >= 0) {
          const buffer = new ArrayBuffer(8);
          new DataView(buffer).setBigUint64(0, BigInt(item));
          out.push(0xcf, ...new Uint8Array(buffer));
        } else {
          const buffer = new ArrayBuffer(8);
          new DataView(buffer).setBigInt64(0, BigInt(item));
          out.push(0xd3, ...new Uint8Array(buffer));
        }
        return;
      }
      const buffer = new ArrayBuffer(8);
      new DataView(buffer).setFloat64(0, item);
      out.push(0xcb, ...new Uint8Array(buffer));
      return;
    }
    if (typeof item === 'string') {
      const encoded = new TextEncoder().encode(item);
      if (encoded.length < 32) out.push(0xa0 | encoded.length);
      else encodeHeader(out, encoded.length);
      for (const byte of encoded) out.push(byte);
      return;
    }
    if (Array.isArray(item)) {
      if (item.length < 16) out.push(0x90 | item.length);
      else if (item.length < 0x10000) out.push(0xdc, item.length >> 8, item.length & 0xff);
      else out.push(0xdd, (item.length >>> 24) & 0xff, (item.length >>> 16) & 0xff, (item.length >>> 8) & 0xff, item.length & 0xff);
      for (const entry of item) write(entry);
      return;
    }
    if (item instanceof Uint8Array) {
      out.push(0xc6, (item.length >>> 24) & 0xff, (item.length >>> 16) & 0xff, (item.length >>> 8) & 0xff, item.length & 0xff, ...item);
      return;
    }
    if (typeof item === 'object') {
      const entries = Object.entries(item);
      if (entries.length < 16) out.push(0x80 | entries.length);
      else out.push(0xde, entries.length >> 8, entries.length & 0xff);
      for (const [key, entry] of entries) {
        write(key);
        write(entry);
      }
      return;
    }
    throw new Error(`Cannot MessagePack-encode ${typeof item}`);
  };
  write(value);
  return Uint8Array.from(out);
}
