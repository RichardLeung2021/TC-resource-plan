// Lucky resource plan API (AWS Lambda, Node.js 24, API Gateway HTTP API v2 payload).
//
// Stores every document in one DynamoDB table:
//   pk = collection name, sk = document id, body = JSON string of the document.
// A single counter item (pk "_meta", sk "version") goes up on every write so
// browsers can poll cheaply for changes.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, PutCommand, DeleteCommand, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { timingSafeEqual } from 'node:crypto';

const TABLE = process.env.TABLE_NAME;
const PASSCODE = process.env.PASSCODE || '';
const COLLECTIONS = new Set(['config', 'projects', 'people', 'resources']);
const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const MAX_BODY = 256 * 1024;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const json = (status, body) => ({
  statusCode: status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: body === undefined ? '' : JSON.stringify(body),
});

function authorised(event) {
  if (!PASSCODE) return true; // no passcode configured: open access (not recommended)
  const given = Buffer.from(String(event.headers?.['x-plan-passcode'] || ''));
  const want = Buffer.from(PASSCODE);
  return given.length === want.length && timingSafeEqual(given, want);
}

async function currentVersion() {
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: '_meta', sk: 'version' } }));
  return r.Item?.v ?? 0;
}

async function bumpVersion() {
  const r = await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: '_meta', sk: 'version' },
    UpdateExpression: 'ADD v :one',
    ExpressionAttributeValues: { ':one': 1 },
    ReturnValues: 'UPDATED_NEW',
  }));
  return r.Attributes.v;
}

async function readCollection(col) {
  const out = [];
  let ExclusiveStartKey;
  do {
    const r = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': col },
      ExclusiveStartKey,
    }));
    for (const it of r.Items || []) out.push({ id: it.sk, data: JSON.parse(it.body) });
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

export const handler = async (event) => {
  try {
    if (!authorised(event)) return json(401, { error: 'Passcode required' });

    const method = event.requestContext?.http?.method;
    const path = (event.rawPath || '').replace(/\/+$/, '');

    if (method === 'GET' && path === '/api/version') {
      return json(200, { version: await currentVersion() });
    }

    if (method === 'GET' && path === '/api/state') {
      const version = await currentVersion();
      const cols = [...COLLECTIONS];
      const results = await Promise.all(cols.map(readCollection));
      const collections = Object.fromEntries(cols.map((c, i) => [c, results[i]]));
      return json(200, { version, collections });
    }

    const m = /^\/api\/docs\/([^/]+)\/([^/]+)$/.exec(path);
    if (m) {
      const col = decodeURIComponent(m[1]);
      const id = decodeURIComponent(m[2]);
      if (!COLLECTIONS.has(col) || !ID_RE.test(id)) return json(400, { error: 'Unknown collection or bad id' });

      if (method === 'PUT') {
        const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
        if (Buffer.byteLength(raw) > MAX_BODY) return json(413, { error: 'Document too large' });
        let doc;
        try { doc = JSON.parse(raw); } catch { return json(400, { error: 'Body must be JSON' }); }
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return json(400, { error: 'Body must be a JSON object' });
        await ddb.send(new PutCommand({
          TableName: TABLE,
          Item: { pk: col, sk: id, body: JSON.stringify(doc), updatedAt: new Date().toISOString() },
        }));
        return json(200, { version: await bumpVersion() });
      }

      if (method === 'DELETE') {
        await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: col, sk: id } }));
        return json(200, { version: await bumpVersion() });
      }
    }

    return json(404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    return json(500, { error: 'Server error' });
  }
};
