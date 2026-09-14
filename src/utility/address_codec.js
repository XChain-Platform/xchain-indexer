/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Indexer - Utility: base58check and bech32 codec
 *
 * Decodes and encodes base58check and bech32/bech32m addresses. The per-coin version
 * bytes and HRPs these are checked against (ADDRESS_PARAMS) stay in ../utility.js, which
 * owns the address rules; this part is the byte-level codec only.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');

// The base58 alphabet and the bech32 charset, checksum constants and generator the codec
// below is built on (BIP-173 for segwit v0, BIP-350 for v1 and later).
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BECH32_CHARSET  = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_CONST    = 1;          // BIP-173 checksum constant (segwit v0)
const BECH32M_CONST   = 0x2bc830a3; // BIP-350 checksum constant (segwit v1+)
const BECH32_GEN      = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

// Installed onto Utility.prototype by ../utility.js, non-enumerable; each method runs with
// `this` bound to the Utility instance, exactly as the class method it was.
module.exports = {

    // Decode a base58check string and return its payload bytes, or false if the
    // string is not valid base58check (bad charset, bad length, bad checksum)
    base58CheckDecode(address){
        let str = String(address);
        // Reject anything outside the plausible base58check address length band
        if(str.length<26 || str.length>48)
            return false;
        // Decode base58 to a big integer, rejecting any out-of-alphabet character
        let num = 0n;
        for(let char of str){
            let value = BASE58_ALPHABET.indexOf(char);
            if(value==-1)
                return false;
            num = num * 58n + BigInt(value);
        }
        // Convert integer to bytes, restoring leading zero bytes (leading '1' chars)
        let hex = num.toString(16);
        if(hex.length % 2)
            hex = '0' + hex;
        let bytes = Buffer.from(hex,'hex');
        if(num==0n)
            bytes = Buffer.alloc(0);
        let leading = 0;
        while(leading<str.length && str[leading]=='1')
            leading++;
        let data = Buffer.concat([Buffer.alloc(leading), bytes]);
        // Last 4 bytes are a double-SHA256 checksum over the payload
        if(data.length<5)
            return false;
        let payload  = data.subarray(0, data.length-4);
        let checksum = data.subarray(data.length-4);
        let hash = crypto.createHash('sha256').update(crypto.createHash('sha256').update(payload).digest()).digest();
        if(!hash.subarray(0,4).equals(checksum))
            return false;
        return payload;
    },

    // Decode a bech32/bech32m string (BIP-173/BIP-350) and return
    // { hrp, version, program } for a valid segwit address, or false
    bech32Decode(address){
        let str = String(address);
        // Reject mixed case, then work in lowercase (all-uppercase is allowed)
        if(str!=str.toLowerCase() && str!=str.toUpperCase())
            return false;
        str = str.toLowerCase();
        if(str.length<8 || str.length>90)
            return false;
        // Split on the last '1' separator
        let pos = str.lastIndexOf('1');
        if(pos<1 || pos+7>str.length)
            return false;
        let hrp  = str.substring(0,pos);
        let data = [];
        for(let char of str.substring(pos+1)){
            let value = BECH32_CHARSET.indexOf(char);
            if(value==-1)
                return false;
            data.push(value);
        }
        // Verify the BCH checksum (BIP-173 polymod over expanded hrp + data)
        let chk = this.bech32Polymod(hrp, data);
        // Witness version is the first data value; remaining values (minus the
        // 6 checksum chars) are the witness program in 5-bit groups
        let version = data[0];
        if(version>16)
            return false;
        // Segwit v0 uses the bech32 constant, v1+ uses bech32m (BIP-350)
        if(chk!=(version==0 ? BECH32_CONST : BECH32M_CONST))
            return false;
        // Convert the witness program from 5-bit to 8-bit groups (no padding bits set)
        let bits = 0, acc = 0, program = [];
        for(let value of data.slice(1, data.length-6)){
            acc  = (acc<<5)|value;
            bits += 5;
            while(bits>=8){
                bits -= 8;
                program.push((acc>>bits)&0xff);
            }
        }
        if(bits>=5 || ((acc<<(8-bits))&0xff))
            return false;
        // Witness program length rules (BIP-141): 2-40 bytes, v0 exactly 20 or 32
        if(program.length<2 || program.length>40)
            return false;
        if(version==0 && program.length!=20 && program.length!=32)
            return false;
        return { hrp: hrp, version: version, program: program };
    },

    // BIP-173 BCH polymod over the expanded HRP plus the given 5-bit data values.
    // Shared by bech32Decode (verify: result must equal the checksum constant) and
    // bech32Encode (create: result over data + six zeros, XOR the constant, yields
    // the 6 checksum values).
    bech32Polymod(hrp, data){
        let values = [];
        for(let i=0; i<hrp.length; i++)
            values.push(hrp.charCodeAt(i)>>5);
        values.push(0);
        for(let i=0; i<hrp.length; i++)
            values.push(hrp.charCodeAt(i)&31);
        values = values.concat(data);
        let chk = 1;
        for(let value of values){
            let top = chk>>25;
            chk = ((chk&0x1ffffff)<<5)^value;
            for(let i=0; i<5; i++)
                if((top>>i)&1)
                    chk ^= BECH32_GEN[i];
        }
        return chk;
    },

    // Encode payload bytes as a base58check string (inverse of base58CheckDecode):
    // append a 4-byte double-SHA256 checksum, base58-encode the big integer, and
    // express leading zero bytes as leading '1' characters. Returns false on empty
    // or non-Buffer input.
    base58CheckEncode(payload){
        if(!Buffer.isBuffer(payload) || payload.length==0)
            return false;
        let hash = crypto.createHash('sha256').update(crypto.createHash('sha256').update(payload).digest()).digest();
        let data = Buffer.concat([payload, hash.subarray(0,4)]);
        let num  = BigInt('0x' + data.toString('hex'));
        let str  = '';
        while(num>0n){
            str = BASE58_ALPHABET[Number(num % 58n)] + str;
            num = num / 58n;
        }
        for(let byte of data){
            if(byte!=0)
                break;
            str = '1' + str;
        }
        return str;
    },

    // Encode a segwit address as bech32 (v0) / bech32m (v1+) per BIP-173/BIP-350
    // (inverse of bech32Decode). `program` is the witness program bytes (Buffer or
    // array). Returns false on any input that could not round-trip through
    // bech32Decode (bad version, out-of-range program length).
    bech32Encode(hrp, version, program){
        if(this.isNull(hrp) || String(hrp).length<1 || !Number.isInteger(version) || version<0 || version>16)
            return false;
        let bytes = Array.from(program || []);
        if(bytes.length<2 || bytes.length>40)
            return false;
        if(version==0 && bytes.length!=20 && bytes.length!=32)
            return false;
        // Regroup the witness program from 8-bit to 5-bit values (pad the tail with zero bits)
        let bits = 0, acc = 0, data = [version];
        for(let byte of bytes){
            acc  = (acc<<8)|byte;
            bits += 8;
            while(bits>=5){
                bits -= 5;
                data.push((acc>>bits)&31);
            }
        }
        if(bits>0)
            data.push((acc<<(5-bits))&31);
        // Checksum: polymod over hrp + data + six zero placeholders, XOR the version's constant
        let chk = this.bech32Polymod(hrp, data.concat([0,0,0,0,0,0])) ^ (version==0 ? BECH32_CONST : BECH32M_CONST);
        for(let i=0; i<6; i++)
            data.push((chk>>(5*(5-i)))&31);
        let str = hrp + '1';
        for(let value of data)
            str += BECH32_CHARSET[value];
        return str;
    }
};
