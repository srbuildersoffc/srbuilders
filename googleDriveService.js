'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const https  = require('https');

// Per-instance cache for folder IDs and OAuth tokens.
// NOTE (Vercel Serverless): Module-level state is not shared across serverless
// function instances and is cleared on cold starts. On a cold start or different
// instance, getAccessToken() / getOrCreateSiteFolder() will cleanly re-fetch.
const folderCache = new Map();
let cachedAccessToken = null;
let tokenExpiresAt = 0;

/**
 * Sanitizes description for filename
 * "rename the image to the expence description followed by date"
 */
function buildFileName(description, expenseDate, extension = 'jpg') {
  const cleanDesc = String(description || 'Expense')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80); // avoid excessively long filenames
  const cleanDate = String(expenseDate || new Date().toISOString().slice(0, 10)).trim();
  return `${cleanDesc}_${cleanDate}.${extension}`;
}

/**
 * Checks which Google Drive configuration is available
 */
function getDriveMode() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
    return 'SERVICE_ACCOUNT';
  }
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN) {
    return 'OAUTH2';
  }
  if (process.env.GOOGLE_DRIVE_WEBHOOK_URL) {
    return 'WEBHOOK';
  }
  return 'LOCAL';
}

/**
 * Helper to make HTTPS requests using native Node.js https (supports redirects)
 */
function httpsRequest(urlStr, options = {}, bodyBuffer = null, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      return reject(new Error('Too many redirects'));
    }

    const url = new URL(urlStr);
    const reqOptions = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = https.request(reqOptions, (res) => {
      // Follow 301, 302, 303, 307, 308 redirects (crucial for Google Apps Script Web Apps)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const nextUrl = new URL(res.headers.location, urlStr).toString();
        // Redirect after POST should be followed via GET
        return httpsRequest(nextUrl, { method: 'GET', headers: {} }, null, redirectCount + 1).then(resolve, reject);
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch (_) {
          parsed = raw;
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
        } else {
          const err = new Error(`HTTP ${res.statusCode}: ${typeof parsed === 'object' ? JSON.stringify(parsed) : parsed}`);
          err.statusCode = res.statusCode;
          err.response = parsed;
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });

    if (bodyBuffer) {
      req.write(bodyBuffer);
    }
    req.end();
  });
}

/**
 * Generates an OAuth2 access token for Google Service Account using pure crypto
 */
async function getServiceAccountToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedAccessToken && tokenExpiresAt > now + 60) {
    return cachedAccessToken;
  }

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !privateKey) {
    throw new Error('Missing Google Service Account credentials');
  }

  // Handle escaped newlines from .env file
  privateKey = privateKey.replace(/\\n/g, '\n');

  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  const b64Header = Buffer.from(JSON.stringify(header)).toString('base64url');
  const b64Claim  = Buffer.from(JSON.stringify(claimSet)).toString('base64url');
  const signatureInput = `${b64Header}.${b64Claim}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signatureInput);
  const signature = signer.sign(privateKey, 'base64url');

  const assertion = `${signatureInput}.${signature}`;
  const postData = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(assertion)}`;

  const res = await httpsRequest('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData)
    }
  }, Buffer.from(postData));

  cachedAccessToken = res.access_token;
  tokenExpiresAt = now + (res.expires_in || 3600);
  return cachedAccessToken;
}

/**
 * Refresh OAuth2 token if using client ID/Secret/Refresh Token
 */
async function getOAuth2Token() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedAccessToken && tokenExpiresAt > now + 60) {
    return cachedAccessToken;
  }

  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  const postData = `client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&refresh_token=${encodeURIComponent(refreshToken)}&grant_type=refresh_token`;

  const res = await httpsRequest('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData)
    }
  }, Buffer.from(postData));

  cachedAccessToken = res.access_token;
  tokenExpiresAt = now + (res.expires_in || 3600);
  return cachedAccessToken;
}

/**
 * Gets valid Google Drive access token
 */
async function getAccessToken() {
  const mode = getDriveMode();
  if (mode === 'SERVICE_ACCOUNT') return await getServiceAccountToken();
  if (mode === 'OAUTH2') return await getOAuth2Token();
  return null;
}

/**
 * Finds or creates a specific folder for the given site in Google Drive.
 * Each site has its own folder, e.g. "S001 - Sharma Residence"
 */
async function getOrCreateSiteFolder(token, siteId, siteName) {
  const cacheKey = siteId;
  if (folderCache.has(cacheKey)) {
    return folderCache.get(cacheKey);
  }

  const parentFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || null;
  const folderName = `${siteId} - ${siteName || 'Site'}`.trim();

  // Search for folder with this name
  let query = `mimeType='application/vnd.google-apps.folder' and name='${folderName.replace(/'/g, "\\'")}' and trashed=false`;
  if (parentFolderId) {
    query += ` and '${parentFolderId}' in parents`;
  }

  const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`;
  const searchRes = await httpsRequest(searchUrl, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (searchRes.files && searchRes.files.length > 0) {
    const existingId = searchRes.files[0].id;
    folderCache.set(cacheKey, existingId);
    return existingId;
  }

  // Folder does not exist, create it!
  const metadata = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder'
  };
  if (parentFolderId) {
    metadata.parents = [parentFolderId];
  }

  const metaStr = JSON.stringify(metadata);
  const createRes = await httpsRequest('https://www.googleapis.com/drive/v3/files?fields=id,name', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(metaStr)
    }
  }, Buffer.from(metaStr));

  const newFolderId = createRes.id;
  folderCache.set(cacheKey, newFolderId);
  return newFolderId;
}

/**
 * Uploads a file to Google Drive via multipart upload
 */
async function uploadToDrive(token, folderId, fileName, mimeType, fileBuffer) {
  const boundary = '-------314159265358979323846';
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  const metadata = {
    name: fileName,
    parents: folderId ? [folderId] : []
  };

  const multipartHeader = `${delimiter}Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}${delimiter}Content-Type: ${mimeType}\r\nContent-Transfer-Encoding: base64\r\n\r\n`;

  const multipartBody = Buffer.concat([
    Buffer.from(multipartHeader, 'utf8'),
    Buffer.from(fileBuffer.toString('base64'), 'utf8'),
    Buffer.from(closeDelimiter, 'utf8')
  ]);

  const uploadUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,webContentLink,thumbnailLink';
  const uploadRes = await httpsRequest(uploadUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': multipartBody.length
    }
  }, multipartBody);

  // Set file permissions so anyone with the link can view it (useful for ContractFlow viewers)
  try {
    const permBody = JSON.stringify({ role: 'reader', type: 'anyone' });
    await httpsRequest(`https://www.googleapis.com/drive/v3/files/${uploadRes.id}/permissions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(permBody)
      }
    }, Buffer.from(permBody));
  } catch (permErr) {
    console.warn('[DRIVE] Could not set public view permission:', permErr.message);
  }

  // Construct direct viewable URL
  const viewUrl = uploadRes.webViewLink || `https://drive.google.com/file/d/${uploadRes.id}/view?usp=sharing`;
  return {
    fileId: uploadRes.id,
    fileName: uploadRes.name,
    viewUrl: viewUrl
  };
}

/**
 * Saves file locally in public/uploads/:siteId/:fileName as fallback when Google Drive is not configured
 */
function saveLocally(siteId, fileName, fileBuffer) {
  const uploadsDir = path.join(__dirname, 'public', 'uploads', siteId);
  fs.mkdirSync(uploadsDir, { recursive: true });

  const filePath = path.join(uploadsDir, fileName);
  fs.writeFileSync(filePath, fileBuffer);

  const localUrl = `/uploads/${encodeURIComponent(siteId)}/${encodeURIComponent(fileName)}`;
  return {
    fileId: fileName,
    fileName: fileName,
    viewUrl: localUrl,
    isLocal: true
  };
}

/**
 * Main function: upload an expense picture
 * Compresses/processes image, renames to description_date.jpg, saves into site's folder in Google Drive.
 */
async function saveExpenseImage({ siteId, siteName, description, expenseDate, imageBase64, mimeType = 'image/jpeg' }) {
  if (!imageBase64) return null;

  // Clean data URI prefix if present (e.g. data:image/jpeg;base64,...)
  let base64Data = imageBase64;
  let detectedMime = mimeType;
  if (imageBase64.includes(';base64,')) {
    const parts = imageBase64.split(';base64,');
    const match = parts[0].match(/:(.*?)$/);
    if (match) detectedMime = match[1];
    base64Data = parts[1];
  }

  const fileBuffer = Buffer.from(base64Data, 'base64');
  const ext = detectedMime.includes('png') ? 'png' : 'jpg';
  const fileName = buildFileName(description, expenseDate, ext);

  const mode = getDriveMode();

  if (mode === 'SERVICE_ACCOUNT' || mode === 'OAUTH2') {
    try {
      const token = await getAccessToken();
      const folderId = await getOrCreateSiteFolder(token, siteId, siteName);
      const uploaded = await uploadToDrive(token, folderId, fileName, detectedMime, fileBuffer);
      console.log(`[DRIVE] Uploaded ${fileName} to folder ${folderId} (${siteName}) -> ${uploaded.viewUrl}`);
      return uploaded;
    } catch (driveErr) {
      console.error('[DRIVE ERROR] Upload to Google Drive failed:', driveErr.message);
      console.log('[DRIVE] Falling back to local storage...');
      return saveLocally(siteId, fileName, fileBuffer);
    }
  }

  if (mode === 'WEBHOOK') {
    try {
      const webhookUrl = process.env.GOOGLE_DRIVE_WEBHOOK_URL;
      const payloadObj = {
        siteId,
        siteName,
        fileName,
        expenseDate,
        description,
        mimeType: detectedMime,
        base64: base64Data
      };

      let resData = null;

      if (typeof fetch === 'function') {
        const fetchRes = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payloadObj),
          redirect: 'follow'
        });
        const text = await fetchRes.text();
        try {
          resData = JSON.parse(text);
        } catch (_) {
          throw new Error(`Invalid response from webhook: ${text.slice(0, 300)}`);
        }
      } else {
        const payload = JSON.stringify(payloadObj);
        resData = await httpsRequest(webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        }, Buffer.from(payload));
      }

      if (resData && resData.error) {
        throw new Error(`Google Apps Script error: ${resData.error}`);
      }

      const driveUrl = resData.viewUrl || resData.url;
      console.log(`[DRIVE WEBHOOK] Uploaded ${fileName} -> ${driveUrl}`);
      return {
        fileId: resData.fileId || fileName,
        fileName: fileName,
        viewUrl: driveUrl
      };
    } catch (hookErr) {
      console.error('[DRIVE WEBHOOK ERROR]:', hookErr.message);
      return saveLocally(siteId, fileName, fileBuffer);
    }
  }

  // Default: local storage fallback
  console.log(`[INFO] Google Drive credentials not configured. Saving ${fileName} locally.`);
  return saveLocally(siteId, fileName, fileBuffer);
}

/**
 * Extracts Google Drive file ID from a view/sharing URL
 */
function extractFileIdFromUrl(url) {
  if (!url) return null;
  const match = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/) || url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * Deletes an expense image from Google Drive (or local storage)
 */
async function deleteExpenseImage(receiptUrl) {
  if (!receiptUrl) return;

  // Handle local file fallback
  if (receiptUrl.startsWith('/uploads/')) {
    try {
      const relativePath = decodeURIComponent(receiptUrl.replace(/^\//, ''));
      const localPath = path.join(__dirname, 'public', relativePath);
      if (fs.existsSync(localPath)) {
        fs.unlinkSync(localPath);
        console.log('[LOCAL] Deleted file:', localPath);
      }
    } catch (e) {
      console.warn('[LOCAL DELETE NOTE]:', e.message);
    }
    return;
  }

  const fileId = extractFileIdFromUrl(receiptUrl);
  if (!fileId) return;

  const mode = getDriveMode();

  if (mode === 'WEBHOOK') {
    try {
      const webhookUrl = process.env.GOOGLE_DRIVE_WEBHOOK_URL;
      const payloadObj = { action: 'delete', fileId: fileId };

      if (typeof fetch === 'function') {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payloadObj),
          redirect: 'follow'
        });
      } else {
        const payload = JSON.stringify(payloadObj);
        await httpsRequest(webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        }, Buffer.from(payload));
      }
      console.log(`[DRIVE WEBHOOK] Deleted file ${fileId} from Google Drive`);
    } catch (err) {
      console.error('[DRIVE DELETE ERROR]:', err.message);
    }
    return;
  }

  if (mode === 'SERVICE_ACCOUNT' || mode === 'OAUTH2') {
    try {
      const token = await getAccessToken();
      await httpsRequest(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      console.log(`[DRIVE] Deleted file ${fileId} from Google Drive`);
    } catch (err) {
      console.error('[DRIVE DELETE ERROR]:', err.message);
    }
  }
}

module.exports = {
  buildFileName,
  getDriveMode,
  saveExpenseImage,
  extractFileIdFromUrl,
  deleteExpenseImage
};
