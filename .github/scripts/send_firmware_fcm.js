/**
 * .github/scripts/send_firmware_fcm.js
 * =====================================
 * Sends an FCM push notification to the 'firmware-updates' topic
 * using Firebase Cloud Messaging HTTP v1 API.
 *
 * Supports both firmware.bin releases and app-release.apk self-updates.
 */

const crypto = require('crypto');
const https = require('https');

function base64UrlEncode(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Generates an OAuth2 access token for Firebase Messaging using Google Service Account
 */
async function getGoogleOAuth2Token(serviceAccount) {
  const header = {
    alg: 'RS256',
    typ: 'JWT',
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signInput = `${encodedHeader}.${encodedPayload}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signInput);
  signer.end();

  const signature = signer.sign(serviceAccount.private_key, 'base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const assertion = `${signInput}.${signature}`;

  const tokenRequestBody = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: assertion,
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request(
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(tokenRequestBody),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data);
              resolve(parsed.access_token);
            } catch (err) {
              reject(new Error(`Failed to parse OAuth2 token response: ${err.message}`));
            }
          } else {
            reject(new Error(`OAuth2 token error (${res.statusCode}): ${data}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.write(tokenRequestBody);
    req.end();
  });
}

/**
 * Sends FCM HTTP v1 Topic Message
 */
async function sendFcmMessage(serviceAccount, accessToken, tag, downloadUrl, repo, assetFile, isApk, fileSize) {
  const projectId = serviceAccount.project_id;
  const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

  const isAppUpdate = isApk || (assetFile && assetFile.endsWith('.apk'));
  const title = isAppUpdate ? 'StrideSense App Update' : 'StrideSense Firmware Update';
  const body = isAppUpdate
    ? `StrideSense version ${tag} is available with new home screen features! Tap to update.`
    : `New firmware ${tag} is available for your pod. Tap to download.`;

  const payload = {
    message: {
      topic: 'firmware-updates',
      notification: {
        title,
        body,
      },
      data: {
        type: isAppUpdate ? 'app_ota' : 'firmware_ota',
        version: tag,
        url: downloadUrl,
        fileName: assetFile || 'firmware.bin',
        isApk: isAppUpdate ? 'true' : 'false',
        fileSize: fileSize ? String(fileSize) : '',
        repository: repo,
        releasedAt: new Date().toISOString(),
      },
      android: {
        priority: 'high',
        notification: {
          channel_id: 'firmware-updates',
          click_action: 'FIRMWARE_UPDATE_NOTIFICATION',
          default_sound: true,
          default_vibrate_timings: true,
        },
      },
    },
  };

  const bodyString = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyString),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`FCM API error (${res.statusCode}): ${data}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.write(bodyString);
    req.end();
  });
}

async function main() {
  const secret = process.env.FIREBASE_SERVICE_ACCOUNT;
  const tag = process.env.TAG || process.env.GITHUB_REF_NAME;
  const repo = process.env.REPO || process.env.GITHUB_REPOSITORY;
  const assetFile = process.env.ASSET_FILE || 'firmware.bin';
  const isApk = process.env.IS_APK === 'true' || assetFile.endsWith('.apk');
  const fileSize = process.env.FILE_SIZE || '';

  if (!secret) {
    console.error('ERROR: FIREBASE_SERVICE_ACCOUNT secret is missing or empty!');
    process.exit(1);
  }

  if (!tag) {
    console.error('ERROR: Release TAG is missing!');
    process.exit(1);
  }

  if (!repo) {
    console.error('ERROR: GITHUB_REPOSITORY is missing!');
    process.exit(1);
  }

  let serviceAccount;
  try {
    const jsonStr = secret.startsWith('{') ? secret : Buffer.from(secret, 'base64').toString('utf-8');
    serviceAccount = JSON.parse(jsonStr);
  } catch (err) {
    console.error('ERROR: Failed to parse FIREBASE_SERVICE_ACCOUNT as JSON:', err.message);
    process.exit(1);
  }

  const downloadUrl = `https://github.com/${repo}/releases/download/${tag}/${assetFile}`;

  console.log('====================================================');
  console.log('StrideSense OTA Release FCM Dispatcher');
  console.log('====================================================');
  console.log(`Repository:    ${repo}`);
  console.log(`Version Tag:   ${tag}`);
  console.log(`Asset File:    ${assetFile} (isApk: ${isApk})`);
  console.log(`Download URL:  ${downloadUrl}`);
  console.log(`Topic:         firmware-updates`);
  console.log(`Project ID:    ${serviceAccount.project_id}`);
  console.log(`Client Email:  ${serviceAccount.client_email}`);
  console.log('----------------------------------------------------');

  try {
    console.log('Generating Google OAuth2 Access Token...');
    const accessToken = await getGoogleOAuth2Token(serviceAccount);
    console.log('Access token generated successfully.');

    console.log('Dispatching FCM topic notification...');
    const response = await sendFcmMessage(serviceAccount, accessToken, tag, downloadUrl, repo, assetFile, isApk, fileSize);
    console.log('FCM Notification delivered successfully!');
    console.log('Message ID:', response.name);
    console.log('All subscribed phones have been notified.');
  } catch (err) {
    console.error('ERROR delivering FCM notification:', err.message);
    process.exit(1);
  }
}

main();
