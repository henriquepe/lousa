"use strict";

/* Storage de boards: S3 quando LOUSA_BUCKET está definido (Lambda), senão disco local. */

const fs = require("fs");
const os = require("os");
const path = require("path");

const BUCKET = process.env.LOUSA_BUCKET || "";

function fsStore() {
  const dir = process.env.LOUSA_DATA_DIR || path.join(os.homedir(), ".lousa", "boards");
  fs.mkdirSync(dir, { recursive: true });
  const file = id => path.join(dir, `${id}.json`);
  return {
    async get(id) {
      try { return JSON.parse(fs.readFileSync(file(id), "utf8")); }
      catch { return null; }
    },
    async put(board) {
      fs.writeFileSync(file(board.id), JSON.stringify(board, null, 2));
    },
    async remove(id) {
      try { fs.unlinkSync(file(id)); } catch {}
    },
    async list() {
      return fs.readdirSync(dir)
        .filter(f => f.endsWith(".json"))
        .map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return null; } })
        .filter(Boolean);
    },
  };
}

function s3Store() {
  const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
  const client = new S3Client({});
  const key = id => `boards/${id}.json`;
  const readBody = async body => JSON.parse(await body.transformToString());
  return {
    async get(id) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key(id) }));
        return await readBody(out.Body);
      } catch { return null; }
    },
    async put(board) {
      await client.send(new PutObjectCommand({
        Bucket: BUCKET, Key: key(board.id),
        Body: JSON.stringify(board), ContentType: "application/json",
      }));
    },
    async remove(id) {
      try { await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key(id) })); } catch {}
    },
    async list() {
      const out = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "boards/", MaxKeys: 500 }));
      const keys = (out.Contents || []).map(o => o.Key).filter(k => k.endsWith(".json"));
      const boards = await Promise.all(keys.map(async k => {
        try {
          const obj = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: k }));
          return await readBody(obj.Body);
        } catch { return null; }
      }));
      return boards.filter(Boolean);
    },
  };
}

module.exports = BUCKET ? s3Store() : fsStore();
