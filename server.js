const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const cors = require('cors');


process.on('uncaughtException', err => console.error('❌ Uncaught Exception:', err));
process.on('unhandledRejection', err => console.error('❌ Unhandled Rejection:', err));

const app = express();
const upload = multer();
app.use(cors());


app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
}));

const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const POLL_ATTEMPTS = parseInt(process.env.POLL_ATTEMPTS || '30', 10);

if (!SHOP || !TOKEN) {
  console.error('❌ Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN');
  process.exit(1);
}

app.use((req, res, next) => {
  console.log(`→ ${req.method} ${req.url}`);
  next();
});

app.get('/', (req, res) => res.send('🟢 Server is live'));

async function callAdmin(query, variables) {
  const resp = await fetch(
    `https://${SHOP}/admin/api/2025-04/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  const result = await resp.json();
  if (result.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
  }

  return result.data;
}

function getShopifyContentType(mimetype) {
  if (mimetype.startsWith('video/')) return 'VIDEO';
  if (mimetype.startsWith('image/')) return 'IMAGE';
  return 'FILE'; // Covers PDFs, ZIPs, etc.
}

app.post('/upload', upload.single('file'), async (req, res) => {
  console.log('🔔 POST /upload invoked');
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const { buffer, originalname, mimetype, size } = req.file;
    console.log(`📄 Received file: ${originalname} (${size} bytes)`);

    const stagedQuery = `
      mutation($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets { url resourceUrl parameters { name value } }
          userErrors { field message }
        }
      }
    `;
    const stagedVars = {
      input: [{
        filename: originalname,
        mimeType: mimetype,
        httpMethod: 'POST',
        resource: 'FILE',
        fileSize: size.toString(),
      }],
    };
    const { stagedUploadsCreate } = await callAdmin(stagedQuery, stagedVars);
    if (stagedUploadsCreate.userErrors.length) {
      return res.status(422).json({ errors: stagedUploadsCreate.userErrors });
    }

    const target = stagedUploadsCreate.stagedTargets[0];
    console.log('🔗 Upload target:', target.resourceUrl);

    const uploadForm = new FormData();
    target.parameters.forEach(p => uploadForm.append(p.name, p.value));
    uploadForm.append('file', buffer, { filename: originalname, contentType: mimetype });

    const storageRes = await fetch(target.url, {
      method: 'POST',
      body: uploadForm,
      headers: uploadForm.getHeaders(),
    });

    if (!storageRes.ok) {
      const t = await storageRes.text();
      return res.status(storageRes.status).json({ error: 'Storage upload failed', details: t });
    }

    console.log('⬆️  Storage upload success');

    const contentType = getShopifyContentType(mimetype);
    const fileCreateQuery = `
      mutation($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files {
            __typename
            ... on GenericFile { id url }
            ... on MediaImage  { id }
            ... on Video       { id }
          }
          userErrors { field message }
        }
      }
    `;
    const fileCreateVars = {
      files: [{
        originalSource: target.resourceUrl,
        filename: originalname,
        contentType,
      }],
    };

    const { fileCreate } = await callAdmin(fileCreateQuery, fileCreateVars);
    if (fileCreate.userErrors.length) {
      return res.status(422).json({ errors: fileCreate.userErrors });
    }

    const created = fileCreate.files[0];
    console.log('🔖 Created file:', created.__typename, created.id);

    const pollQuery = `
      query($id: ID!) {
        node(id: $id) {
          __typename
          ... on GenericFile {
            fileStatus
            url
          }
          ... on MediaImage {
            fileStatus
            image { url }
          }
          ... on Video {
            fileStatus
            sources { url format }
          }
        }
      }
    `;

    let finalUrl = null;
    let lastStatus = null;

    for (let i = 0; i < POLL_ATTEMPTS; i++) {
      console.log(`⏱ Polling status… attempt ${i + 1}`);
      const { node } = await callAdmin(pollQuery, { id: created.id });

      if (!node) break;
      lastStatus = node.fileStatus;

      if (lastStatus === 'READY') {
        if (node.__typename === 'GenericFile' && node.url) {
          finalUrl = node.url;
          break;
        }
        if (node.__typename === 'MediaImage' && node.image?.url) {
          finalUrl = node.image.url;
          break;
        }
        if (node.__typename === 'Video' && node.sources?.[0]?.url) {
          finalUrl = node.sources[0].url;
          break;
        }
      }

      await new Promise(r => setTimeout(r, 1000));
    }

    if (!finalUrl) {
      return res.status(500).json({
        error: 'File did not become READY in time',
        status: lastStatus || 'UNKNOWN',
      });
    }

    console.log('✅ Final file URL:', finalUrl);
    return res.json({ url: finalUrl });

  } catch (err) {
    console.error('❌ /upload error:', err);
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on http://localhost:${PORT}`);
});
