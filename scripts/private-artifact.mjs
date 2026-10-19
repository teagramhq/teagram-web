import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs';
import {dirname, extname, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readHeadContentSecurityPolicies} from './private-artifact-csp.mjs';

export const PRIVATE_ARTIFACT_MANIFEST = 'mtproto-target.json';
export const PRIVATE_FONT_ASSETS = Object.freeze([
  'Chewy-Regular.ttf',
  'CourierPrime-Bold.ttf',
  'FugazOne-Regular.ttf',
  'KFOlCnqEu92Fr1MmEU9fABc4AMP6lbBP.woff2',
  'KFOlCnqEu92Fr1MmEU9fBBc4AMP6lQ.woff2',
  'KFOlCnqEu92Fr1MmEU9fChc4AMP6lbBP.woff2',
  'KFOmCnqEu92Fr1Mu4mxKKTU1Kg.woff2',
  'KFOmCnqEu92Fr1Mu5mxKKTU1Kvnz.woff2',
  'KFOmCnqEu92Fr1Mu7GxKKTU1Kvnz.woff2',
  'L0xTDF4xlVMF-BfR8bXMIhJHg45mwgGEFl0_3vrtSM1J-gEPT5Ese6hmHSV0me8iUI0lkQ.woff2',
  'L0xTDF4xlVMF-BfR8bXMIhJHg45mwgGEFl0_3vrtSM1J-gEPT5Ese6hmHSZ0me8iUI0lkQ.woff2',
  'L0xTDF4xlVMF-BfR8bXMIhJHg45mwgGEFl0_3vrtSM1J-gEPT5Ese6hmHSd0me8iUI0lkQ.woff2',
  'L0xTDF4xlVMF-BfR8bXMIhJHg45mwgGEFl0_3vrtSM1J-gEPT5Ese6hmHSh0me8iUI0.woff2',
  'L0xTDF4xlVMF-BfR8bXMIhJHg45mwgGEFl0_3vrtSM1J-gEPT5Ese6hmHSt0me8iUI0lkQ.woff2',
  'L0xTDF4xlVMF-BfR8bXMIhJHg45mwgGEFl0_3vrtSM1J-gEPT5Ese6hmHSx0me8iUI0lkQ.woff2',
  'L0xdDF4xlVMF-BfR8bXMIjhOsXG-q2oeuFoqFrlnAIe2Imhk1T8rbociImtElOUlco8VkKjG.woff2',
  'L0xdDF4xlVMF-BfR8bXMIjhOsXG-q2oeuFoqFrlnAIe2Imhk1T8rbociImtEleUlco8VkKjG.woff2',
  'L0xdDF4xlVMF-BfR8bXMIjhOsXG-q2oeuFoqFrlnAIe2Imhk1T8rbociImtEluUlco8VkKjG.woff2',
  'L0xdDF4xlVMF-BfR8bXMIjhOsXG-q2oeuFoqFrlnAIe2Imhk1T8rbociImtEm-Ulco8VkA.woff2',
  'L0xdDF4xlVMF-BfR8bXMIjhOsXG-q2oeuFoqFrlnAIe2Imhk1T8rbociImtEmOUlco8VkKjG.woff2',
  'L0xdDF4xlVMF-BfR8bXMIjhOsXG-q2oeuFoqFrlnAIe2Imhk1T8rbociImtEn-Ulco8VkKjG.woff2',
  'Numbers-Rounded.woff2',
  'PlaywriteBEVLG-Regular.ttf',
  'Roboto-Medium.woff',
  'Roboto-Medium.woff2',
  'RubikBubbles-Regular.ttf',
  'Sedan-Regular.ttf',
  'SuezOne-Regular.ttf',
  'tgico.svg',
  'tgico.ttf',
  'tgico.woff'
]);

const PRIVATE_FONT_ASSET_SET = new Set(PRIVATE_FONT_ASSETS);
const PRIVATE_FONT_NAME_PATTERN = /^[A-Za-z0-9_-]+\.(?:woff2|woff|ttf)$/;
const PRIVATE_FONT_SOURCE_DIRECTORY = 'public/assets/fonts';
const PRIVATE_FONT_SVG_SHA256 = '22059cf81a0302ce3c7943e5e5325316ac7a8ac18099b515200efbb93938a505';
export const PRIVATE_BACKGROUND_ASSETS = Object.freeze([
  Object.freeze({
    name: 'pattern.svg',
    size: 507515,
    sha256: '1438ef595b769726f29bb0d2353e8fe41ce0df29309e83d017287800a774de77'
  })
]);
const PRIVATE_BACKGROUND_ASSET_SET = new Set(PRIVATE_BACKGROUND_ASSETS.map(({name}) => name));
const PRIVATE_BACKGROUND_SOURCE_DIRECTORY = 'public/assets/img';
const PRIVATE_RUNTIME_ASSET_SOURCE_DIRECTORY = 'public/assets';
const PRIVATE_ARTIFACT_REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE_ROOT_RUNTIME_ASSETS = Object.freeze([
  'browserconfig.xml',
  'decoderWorker.min.js',
  'decoderWorker.min.wasm',
  'encoderWorker.min.js',
  'encoderWorker.min.wasm',
  'waveWorker.min.js',
  'site.webmanifest',
  'site_apple.webmanifest'
]);
const PRIVATE_RUNTIME_IMAGE_ASSETS = new Set([
  'EmptyChats.svg',
  'accounts-limit-pin-shape.svg',
  'add-chats-to-folder-shape.svg',
  'amex.svg',
  'android-chrome-144x144.png',
  'android-chrome-192x192.png',
  'android-chrome-256x256.png',
  'android-chrome-36x36.png',
  'android-chrome-384x384.png',
  'android-chrome-48x48.png',
  'android-chrome-512x512.png',
  'android-chrome-72x72.png',
  'android-chrome-96x96.png',
  'android-device.svg',
  'anon_paid_reaction.png',
  'apple-touch-icon-precomposed.png',
  'apple-touch-icon.png',
  'bg.jpeg',
  'blank.gif',
  'camomile.jpg',
  'camomile_blurred.jpg',
  'camomile_blurred_old.jpg',
  'card.svg',
  'chat-thread-separator-dash-black.svg',
  'chat-thread-separator-dash.svg',
  'diners.svg',
  'discover.svg',
  'doc-in.svg',
  'favicon-16x16.png',
  'favicon-194x194.png',
  'favicon-32x32.png',
  'favicon.ico',
  'favicon_unread.ico',
  'icon-verified.svg',
  'icon_square_192.png',
  'icon_square_384.png',
  'icon_square_512.png',
  'jcb.svg',
  'logo.svg',
  'logo_512.png',
  'logo_filled.svg',
  'logo_filled_rounded.png',
  'logo_padded.svg',
  'logo_plain.svg',
  'masked copy.svg',
  'masked.svg',
  'mastercard.svg',
  'media-editor-blurred-color-wheel.png',
  'media-editor-border-part-vertical.svg',
  'media-editor-border-part.svg',
  'media-editor-rotation-wheel-mask.svg',
  'mir.svg',
  'monoforum-avatar-mask.svg',
  'mstile-144x144.png',
  'mstile-150x150.png',
  'mstile-310x150.png',
  'mstile-310x310.png',
  'mstile-70x70.png',
  'password-monkey-closed.png',
  'pattern.svg',
  'premium-star.png',
  'premium-star@2x.png',
  'premiumboostsstar.png',
  'premiumboostsstar@2x.png',
  'safari-pinned-tab.svg',
  'screenshot.jpg',
  'spoiler_fragment.glsl',
  'spoiler_vertex.glsl',
  'stars.png',
  'stars@2x.png',
  'stars_pay.png',
  'stars_pay@2x.png',
  'unionpay.svg',
  'visa.svg'
]);
const PRIVATE_RUNTIME_ASSET_EXTENSIONS = new Set([
  '.gif',
  '.glsl',
  '.ico',
  '.jpeg',
  '.jpg',
  '.json',
  '.md',
  '.mp3',
  '.png',
  '.svg',
  '.ttf',
  '.woff',
  '.woff2'
]);
const PRIVATE_EXCLUDED_PUBLIC_ASSET_EXTENSIONS = new Set(['.css', '.html', '.js', '.map', '.mjs']);
const PRIVATE_RUNTIME_ASSET_REFERENCE_PATTERN = /(?:["'`])\/?((?:assets|changelogs)\/[^"'`?#\r\n]+)|url\(\s*["']?\/?(assets\/[^"'`\s)?#]+)["']?\s*\)/g;
const PRIVATE_ROOT_RUNTIME_ASSET_REFERENCE_PATTERN = /["'`](browserconfig\.xml|decoderWorker\.min\.js|decoderWorker\.min\.wasm|encoderWorker\.min\.js|encoderWorker\.min\.wasm|waveWorker\.min\.js|site(?:_apple)?\.webmanifest)(?:[?#][^"'`\s]*)?["'`]/g;
const PRIVATE_RUNTIME_AUDIO_ASSET_NAME_PATTERN = /(['"`])([A-Za-z0-9_-]+\.mp3)\1/g;
const PRIVATE_DYNAMIC_RUNTIME_ASSET_REFERENCE_PATTERNS = Object.freeze([
  Object.freeze({name: 'changelogs', pattern: /["'`]changelogs\/(?=["'`]|\$\{)/}),
  Object.freeze({name: 'lottie', pattern: /["'`]assets\/tgs\/(?=["'`]|\$\{)/}),
  Object.freeze({name: 'audio', pattern: /["'`]assets\/audio\/(?=["'`]|\$\{)/}),
  Object.freeze({name: 'emoji', pattern: /["'`]assets\/img\/emoji\/(?=["'`]|\$\{)/}),
  Object.freeze({name: 'images', pattern: /["'`]assets\/img\/(?=["'`]|\$\{)/})
]);

const PRIVATE_ROUTE_LOCK = {
  mode: 'private',
  transport: 'websocket',
  dcIds: [1, 2, 3, 4, 5],
  connectionTypes: ['client', 'upload', 'download']
};

const TRUSTED_MT_PROTO_FINGERPRINTS = [
  'c3b42b026ce86b21',
  '0bc35f3509f7b7a5',
  '15ae5fa8b5529542',
  'aeae98e13cd7f94f',
  '5a181b2235057d98',
  'b25898df208d2603',
  'd09d1d85de64fd85'
];

const TRUSTED_MT_PROTO_MODULI = [
  'c150023e2f70db7985ded064759cfecf0af328e69a41daf4d6f01b538135a6f91f8f8b2a0ec9ba9720ce352efcf6c5680ffc424bd634864902de0b4bd6d49f4e580230e3ae97d95c8b19442b3c0a10d8f5633fecedd6926a7f6dab0ddb7d457f9ea81b8465fcd6fffeed114011df91c059caedaf97625f6c96ecc74725556934ef781d866b34f011fce4d835a090196e9a5f0e4449af7eb697ddb9076494ca5f81104a305b6dd27665722c46b60e5df680fb16b210607ef217652e60236c255f6a28315f4083a96791d7214bf64c1df4fd0db1944fb26a2a57031b32eee64ad15a8ba68885cde74a5bfc920f6abf59ba5c75506373e7130f9042da922179251f',
  'aeec36c8ffc109cb099624685b97815415657bd76d8c9c3e398103d7ad16c9bba6f525ed0412d7ae2c2de2b44e77d72cbf4b7438709a4e646a05c43427c7f184debf72947519680e651500890c6832796dd11f772c25ff8f576755afe055b0a3752c696eb7d8da0d8be1faf38c9bdd97ce0a77d3916230c4032167100edd0f9e7a3a9b602d04367b689536af0d64b613ccba7962939d3b57682beb6dae5b608130b2e52aca78ba023cf6ce806b1dc49c72cf928a7199d22e3d7ac84e47bc9427d0236945d10dbd15177bab413fbf0edfda09f014c7a7da088dde9759702ca760af2b8e4e97cc055c617bd74c3d97008635b98dc4d621b4891da9fb0473047927',
  'bdf2c77d81f6afd47bd30f29ac76e55adfe70e487e5e48297e5a9055c9c07d2b93b4ed3994d3eca5098bf18d978d54f8b7c713eb10247607e69af9ef44f38e28f8b439f257a11572945cc0406fe3f37bb92b79112db69eedf2dc71584a661638ea5becb9e23585074b80d57d9f5710dd30d2da940e0ada2f1b878397dc1a72b5ce2531b6f7dd158e09c828d03450ca0ff8a174deacebcaa22dde84ef66ad370f259d18af806638012da0ca4a70baa83d9c158f3552bc9158e69bf332a45809e1c36905a5caa12348dd57941a482131be7b2355a5f4635374f3bd3ddf5ff925bf4809ee27c1e67d9120c5fe08a9de458b1b4a3c5d0a428437f2beca81f4e2d5ff',
  'b3f762b739be98f343eb1921cf0148cfa27ff7af02b6471213fed9daa0098976e667750324f1abcea4c31e43b7d11f1579133f2b3d9fe27474e462058884e5e1b123be9cbbc6a443b2925c08520e7325e6f1a6d50e117eb61ea49d2534c8bb4d2ae4153fabe832b9edf4c5755fdd8b19940b81d1d96cf433d19e6a22968a85dc80f0312f596bd2530c1cfb28b5fe019ac9bc25cd9c2a5d8a0f3a1c0c79bcca524d315b5e21b5c26b46babe3d75d06d1cd33329ec782a0f22891ed1db42a1d6c0dea431428bc4d7aabdcf3e0eb6fda4e23eb7733e7727e9a1915580796c55188d2596d2665ad1182ba7abf15aaa5a8b779ea996317a20ae044b820bff35b6e8a1',
  'be6a71558ee577ff03023cfa17aab4e6c86383cff8a7ad38edb9fafe6f323f2d5106cbc8cafb83b869cffd1ccf121cd743d509e589e68765c96601e813dc5b9dfc4be415c7a6526132d0035ca33d6d6075d4f535122a1cdfe017041f1088d1419f65c8e5490ee613e16dbf662698c0f54870f0475fa893fc41eb55b08ff1ac211bc045ded31be27d12c96d8d3cfc6a7ae8aa50bf2ee0f30ed507cc2581e3dec56de94f5dc0a7abee0be990b893f2887bd2c6310a1e0a9e3e38bd34fded2541508dc102a9c9b4c95effd9dd2dfe96c29be647d6c69d66ca500843cfaed6e440196f1dbe0e2e22163c61ca48c79116fa77216726749a976a1c4b0944b5121e8c01',
  'c8c11d635691fac091dd9489aedced2932aa8a0bcefef05fa800892d9b52ed03200865c9e97211cb2ee6c7ae96d3fb0e15aeffd66019b44a08a240cfdd2868a85e1f54d6fa5deaa041f6941ddf302690d61dc476385c2fa655142353cb4e4b59f6e5b6584db76fe8b1370263246c010c93d011014113ebdf987d093f9d37c2be48352d69a1683f8f6e6c2167983c761e3ab169fde5daaa12123fa1beab621e4da5935e9c198f82f35eae583a99386d8110ea6bd1abb0f568759f62694419ea5f69847c43462abef858b4cb5edc84e7b9226cd7bd7e183aa974a712c079dde85b9dc063b8a5c08e8f859c0ee5dcd824c7807f20153361a7f63cfd2a433a1be7f5',
  'e8bb3305c0b52c6cf2afdf7637313489e63e05268e5badb601af417786472e5f93b85438968e20e6729a301c0afc121bf7151f834436f7fda680847a66bf64accec78ee21c0b316f0edafe2f41908da7bd1f4a5107638eeb67040ace472a14f90d9f7c2b7def99688ba3073adb5750bb02964902a359fe745d8170e36876d4fd8a5d41b2a76cbff9a13267eb9580b2d06d10357448d20d9da2191cb5d8c93982961cdfdeda629e37f1fb09a0722027696032fe61ed663db7a37f6f263d370f69db53a0dc0a1748bdaaff6209d5645485e6e001d1953255757e4b8e42813347b11da6ab500fd0ace7e6dfa3736199ccaf9397ed0745a427dcfa6cd67bcb1acff3'
];

const PRIVATE_EXECUTABLE_EXTENSIONS = new Set(['.js', '.mjs']);
const OFFICIAL_MT_PROTO_ROUTE = /(?:kws[1-5](?:-1)?|pluto(?:-1)?|venus(?:-1)?|aurora(?:-1)?|vesta(?:-1)?|flora(?:-1)?)\.web\.telegram\.org(?:[/:?#]|$)|web\.telegram\.org\/(?:apiw(?:s|_test1|1)?)(?:[/:?#]|$)/i;
const OFFICIAL_MT_PROTO_DYNAMIC_ROUTE = /\$\{[^}]+\}[^`]*\.web\.telegram\.org|['"`]\.?web\.telegram\.org\/?['"`]\s*\+|\+\s*['"`]\.?web\.telegram\.org\/?['"`]/i;
const OFFICIAL_MT_PROTO_DC_HOST = /(?:[a-z0-9-]+\.)+web\.telegram\.org(?:[/:?#]|$)/i;
const OFFICIAL_MT_PROTO_IP = /\b(?:149\.154|149\.155|91\.108)\.\d{1,3}\.\d{1,3}\b/;
const OFFICIAL_MT_PROTO_IPV6 = /\b2001:(?:0*b28|0*67c):(?:0*f23|0*4e8)[0-9a-f]*(?::|[\s"'/?#,\])]|$)/i;
const HTTP_MTPROTO_ROUTE = /https?:\/\/[^\s"'`<>]+\/apiw(?:_test1|1)(?:[/?#"'`<>\s]|$)/i;
const CLEAR_TEXT_WEBSOCKET = /\bws:\/\//i;
const SOURCE_MAP_DIRECTIVE = /(?:\/\/|\/\*)[#@]\s*source(?:MappingURL|URL)\s*=/i;
const PRIVATE_KEY_BLOCK = /-----BEGIN [^\r\n-]*PRIVATE KEY-----/i;
const PRIVATE_WSS_URL = /wss:\/\/[A-Za-z0-9._:[\]-]+(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?(?:\?[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?(?:#[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?/gi;

function invalidArtifact(message) {
  throw new Error('[MT] private artifact ' + message);
}

export function assertPrivateFontAssetName(name) {
  if(typeof name !== 'string' || name.includes('/') || name.includes('\\') ||
    (name !== 'tgico.svg' && !PRIVATE_FONT_NAME_PATTERN.test(name)) ||
    !PRIVATE_FONT_ASSET_SET.has(name)) {
    invalidArtifact('font asset name is invalid or unreviewed');
  }
}

function assertSafePrivateFontSvg(contents) {
  const digest = createHash('sha256').update(contents).digest('hex');
  if(digest !== PRIVATE_FONT_SVG_SHA256) {
    invalidArtifact('font SVG does not match the pinned reviewed SHA-256');
  }
}

function ensurePrivateArtifactDirectory(directory, assetType = 'font') {
  if(!existsSync(directory)) {
    mkdirSync(directory);
  }
  const stats = lstatSync(directory);
  if(stats.isSymbolicLink() || !stats.isDirectory()) {
    invalidArtifact(`${assetType} output path contains a non-directory entry`);
  }
}

function readRequiredPrivateFont(sourceDirectory, canonicalSourceDirectory, name) {
  assertPrivateFontAssetName(name);
  const file = resolve(sourceDirectory, name);
  if(dirname(file) !== resolve(sourceDirectory)) {
    invalidArtifact('font asset path escapes the approved directory');
  }

  const stats = lstatSync(file);
  if(stats.isSymbolicLink() || !stats.isFile() || stats.size === 0) {
    invalidArtifact('required font is missing, empty, or not a regular file');
  }
  accessSync(file, constants.R_OK);
  const canonicalFile = realpathSync(file);
  if(dirname(canonicalFile) !== canonicalSourceDirectory || canonicalFile !== resolve(canonicalSourceDirectory, name)) {
    invalidArtifact('font asset path escapes the approved directory');
  }

  const contents = readFileSync(file);
  if(contents.length === 0) {
    invalidArtifact('required font is empty');
  }
  if(name === 'tgico.svg') {
    assertSafePrivateFontSvg(contents);
  }
  return contents;
}

function privateArtifactFontsDirectory(directory) {
  const artifactDirectory = resolve(directory);
  const assetsDirectory = resolve(artifactDirectory, 'assets');
  const fontsDirectory = resolve(assetsDirectory, 'fonts');
  ensurePrivateArtifactDirectory(artifactDirectory);
  ensurePrivateArtifactDirectory(assetsDirectory);
  ensurePrivateArtifactDirectory(fontsDirectory);
  return fontsDirectory;
}

export function includePrivateArtifactFonts(rootDirectory, directory) {
  if(PRIVATE_FONT_ASSETS.length !== 31 || PRIVATE_FONT_ASSET_SET.size !== PRIVATE_FONT_ASSETS.length) {
    invalidArtifact('font allowlist is invalid');
  }
  for(const name of PRIVATE_FONT_ASSETS) {
    assertPrivateFontAssetName(name);
  }

  const sourceDirectory = resolve(rootDirectory, PRIVATE_FONT_SOURCE_DIRECTORY);
  const sourceDirectoryStats = lstatSync(sourceDirectory);
  if(sourceDirectoryStats.isSymbolicLink() || !sourceDirectoryStats.isDirectory()) {
    invalidArtifact('approved font source directory is missing or invalid');
  }
  const canonicalRootDirectory = realpathSync(rootDirectory);
  const canonicalSourceDirectory = realpathSync(sourceDirectory);
  if(canonicalSourceDirectory !== resolve(canonicalRootDirectory, PRIVATE_FONT_SOURCE_DIRECTORY)) {
    invalidArtifact('approved font source directory escapes the repository root');
  }
  const contents = PRIVATE_FONT_ASSETS.map((name) => [
    name,
    readRequiredPrivateFont(sourceDirectory, canonicalSourceDirectory, name)
  ]);
  const fontsDirectory = privateArtifactFontsDirectory(directory);
  const existingEntries = readdirSync(fontsDirectory, {withFileTypes: true});
  for(const entry of existingEntries) {
    if(!PRIVATE_FONT_ASSET_SET.has(entry.name) || !entry.isFile()) {
      invalidArtifact('font output contains an unreviewed or non-regular entry');
    }
  }

  const existingNames = new Set(existingEntries.map((entry) => entry.name));
  for(const [name, bytes] of contents) {
    const outputPath = resolve(fontsDirectory, name);
    if(dirname(outputPath) !== fontsDirectory) {
      invalidArtifact('font output path escapes the artifact directory');
    }
    if(existingNames.has(name)) {
      const outputStats = lstatSync(outputPath);
      if(outputStats.isSymbolicLink() || !outputStats.isFile() || !readFileSync(outputPath).equals(bytes)) {
        invalidArtifact('existing font output does not match its approved source');
      }
      continue;
    }
    writeFileSync(outputPath, bytes, {flag: 'wx'});
  }
}

function isPrivateRuntimeAssetPath(relativePath) {
  const segments = relativePath.split('/');
  if(!segments.every((segment) => segment && segment !== '.' && segment !== '..' && !segment.includes('\\'))) {
    return false;
  }
  if(relativePath.startsWith('changelogs/')) {
    return /^changelogs\/[A-Za-z0-9-]+_[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(relativePath);
  }
  if(!relativePath.startsWith('assets/')) return PRIVATE_ROOT_RUNTIME_ASSETS.includes(relativePath);

  const assetPath = relativePath.slice('assets/'.length);
  if(!PRIVATE_RUNTIME_ASSET_EXTENSIONS.has(extname(assetPath).toLowerCase())) return false;
  if(/^audio\/[A-Za-z0-9_-]+\.mp3$/i.test(assetPath) || /^tgs\/[A-Za-z0-9_-]+\.json$/i.test(assetPath)) {
    return true;
  }
  if(/^img\/emoji\/[0-9a-f]+(?:-[0-9a-f]+)*\.png$/i.test(assetPath)) return true;
  if(assetPath.startsWith('fonts/')) return PRIVATE_FONT_ASSET_SET.has(assetPath.slice('fonts/'.length));
  if(assetPath.startsWith('img/')) return PRIVATE_RUNTIME_IMAGE_ASSETS.has(assetPath.slice('img/'.length));
  return false;
}

function isPrivateRuntimePublicAssetPath(relativePath) {
  return /^(?:assets\/(?:audio|fonts|img|tgs)|changelogs)\//.test(relativePath);
}

function privateRuntimeAssetSourceFiles(rootDirectory) {
  const sourceDirectory = resolve(rootDirectory, PRIVATE_RUNTIME_ASSET_SOURCE_DIRECTORY);
  let sourceDirectoryStats;
  try {
    sourceDirectoryStats = lstatSync(sourceDirectory);
  } catch(cause) {
    if(cause?.code === 'ENOENT') {
      invalidArtifact('runtime public asset source directory is missing or invalid');
    }
    throw cause;
  }
  if(sourceDirectoryStats.isSymbolicLink() || !sourceDirectoryStats.isDirectory()) {
    invalidArtifact('runtime public asset source directory is missing or invalid');
  }

  const canonicalRootDirectory = realpathSync(rootDirectory);
  const canonicalSourceDirectory = realpathSync(sourceDirectory);
  if(canonicalSourceDirectory !== resolve(canonicalRootDirectory, PRIVATE_RUNTIME_ASSET_SOURCE_DIRECTORY)) {
    invalidArtifact('runtime public asset source directory escapes the repository root');
  }

  const files = [];
  const visit = (directory, relativeDirectory) => {
    for(const entry of readdirSync(directory, {withFileTypes: true})) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if(!relativePath.split('/').every((segment) =>
        segment && segment !== '.' && segment !== '..' && !segment.includes('\\')
      )) {
        invalidArtifact('runtime public asset path is invalid');
      }

      const sourcePath = resolve(directory, entry.name);
      if(entry.isSymbolicLink()) {
        invalidArtifact('runtime public asset source contains a symbolic link');
      }
      if(entry.isDirectory()) {
        visit(sourcePath, relativePath);
        continue;
      }
      if(!entry.isFile()) {
        invalidArtifact('runtime public asset source contains a non-regular entry');
      }
      const assetPath = `assets/${relativePath}`;
      if(PRIVATE_EXCLUDED_PUBLIC_ASSET_EXTENSIONS.has(extname(relativePath).toLowerCase())) continue;
      if(!isPrivateRuntimeAssetPath(assetPath)) {
        invalidArtifact(`runtime public asset source contains an unreviewed file ${relativePath}`);
      }

      const contents = readFileSync(sourcePath);
      if(contents.length === 0) {
        invalidArtifact(`runtime public asset ${relativePath} is empty`);
      }
      files.push([assetPath, contents]);
    }
  };
  visit(sourceDirectory, '');

  const publicDirectory = resolve(rootDirectory, 'public');
  for(const name of PRIVATE_ROOT_RUNTIME_ASSETS) {
    const sourcePath = resolve(publicDirectory, name);
    let stats;
    try {
      stats = lstatSync(sourcePath);
    } catch(cause) {
      if(cause?.code === 'ENOENT') {
        invalidArtifact(`required runtime public asset ${name} is missing`);
      }
      throw cause;
    }
    if(stats.isSymbolicLink() || !stats.isFile() || stats.size === 0) {
      invalidArtifact(`required runtime public asset ${name} is empty or not a regular file`);
    }
    files.push([name, readFileSync(sourcePath)]);
  }

  files.push(...privateChangelogSourceFiles(rootDirectory));

  if(!files.length) {
    invalidArtifact('runtime public asset source contains no supported files');
  }
  return files.sort(([left], [right]) => left.localeCompare(right));
}

function privateChangelogAssetNames(rootDirectory) {
  let entries;
  try {
    entries = readdirSync(rootDirectory, {withFileTypes: true});
  } catch{
    invalidArtifact('CHANGELOG sources for runtime assets are missing or invalid');
  }

  const sources = entries.filter(({name}) => name.startsWith('CHANGELOG') && name.endsWith('.md'));
  if(!sources.length) {
    invalidArtifact('CHANGELOG sources for runtime assets are missing or invalid');
  }

  const names = new Set();
  for(const entry of sources) {
    if(entry.isSymbolicLink() || !entry.isFile()) {
      invalidArtifact('CHANGELOG sources for runtime assets are missing or invalid');
    }
    const language = (entry.name.split('_')[1] || 'en').split('.')[0];
    if(!/^[A-Za-z0-9-]+$/.test(language)) {
      invalidArtifact('CHANGELOG sources for runtime assets are missing or invalid');
    }

    let contents;
    try {
      contents = readFileSync(resolve(rootDirectory, entry.name), 'utf8');
    } catch{
      invalidArtifact('CHANGELOG sources for runtime assets are missing or invalid');
    }
    const versions = [...contents.matchAll(/^### (\S+)/gm)].map(([, version]) => version);
    if(!versions.length || versions.some((version) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version))) {
      invalidArtifact('CHANGELOG sources for runtime assets are missing or invalid');
    }
    for(const version of versions) names.add(`${language}_${version}.md`);
  }

  return [...names].sort();
}

function privateChangelogSourceFiles(rootDirectory) {
  const sourceDirectory = resolve(rootDirectory, 'public/changelogs');
  let stats;
  try {
    stats = lstatSync(sourceDirectory);
  } catch(cause) {
    if(cause?.code === 'ENOENT') {
      invalidArtifact('generated changelog source directory is missing or invalid');
    }
    throw cause;
  }
  if(stats.isSymbolicLink() || !stats.isDirectory()) {
    invalidArtifact('generated changelog source directory is missing or invalid');
  }

  const canonicalRootDirectory = realpathSync(rootDirectory);
  const canonicalSourceDirectory = realpathSync(sourceDirectory);
  if(canonicalSourceDirectory !== resolve(canonicalRootDirectory, 'public/changelogs')) {
    invalidArtifact('generated changelog source directory escapes the repository root');
  }

  const names = privateChangelogAssetNames(rootDirectory);
  const expectedNames = new Set(names);
  const entries = readdirSync(sourceDirectory, {withFileTypes: true});
  if(entries.length !== names.length || entries.some((entry) =>
    !expectedNames.has(entry.name) || entry.isSymbolicLink() || !entry.isFile()
  )) {
    invalidArtifact('generated changelog output does not match its CHANGELOG sources');
  }

  return names.map((name) => {
    const file = resolve(sourceDirectory, name);
    const fileStats = lstatSync(file);
    if(fileStats.isSymbolicLink() || !fileStats.isFile() || fileStats.size === 0) {
      invalidArtifact(`generated changelog ${name} is missing, empty, or not a regular file`);
    }
    accessSync(file, constants.R_OK);
    const canonicalFile = realpathSync(file);
    if(dirname(canonicalFile) !== canonicalSourceDirectory || canonicalFile !== resolve(canonicalSourceDirectory, name)) {
      invalidArtifact('generated changelog path escapes the approved directory');
    }
    const contents = readFileSync(file);
    if(contents.length === 0) {
      invalidArtifact(`generated changelog ${name} is empty`);
    }
    return [`changelogs/${name}`, contents];
  });
}

function ensurePrivateRuntimeAssetOutputDirectory(artifactDirectory, relativeDirectory) {
  const rootDirectory = resolve(artifactDirectory);
  ensurePrivateArtifactDirectory(rootDirectory, 'runtime public asset');

  let currentDirectory = rootDirectory;
  for(const segment of relativeDirectory ? relativeDirectory.split('/') : []) {
    currentDirectory = resolve(currentDirectory, segment);
    ensurePrivateArtifactDirectory(currentDirectory, 'runtime public asset');
  }
  return currentDirectory;
}

export function includePrivateArtifactRuntimeAssets(rootDirectory, directory) {
  const files = privateRuntimeAssetSourceFiles(rootDirectory);
  const artifactDirectory = resolve(directory);
  for(const [relativePath, contents] of files) {
    if(!isPrivateRuntimeAssetPath(relativePath)) {
      invalidArtifact('runtime public asset path is invalid or unreviewed');
    }
    const segments = relativePath.split('/');
    const filename = segments.pop();
    const outputDirectory = ensurePrivateRuntimeAssetOutputDirectory(artifactDirectory, segments.join('/'));
    const outputPath = resolve(outputDirectory, filename);
    if(dirname(outputPath) !== outputDirectory) {
      invalidArtifact('runtime public asset output path escapes the artifact directory');
    }

    if(existsSync(outputPath)) {
      const outputStats = lstatSync(outputPath);
      if(outputStats.isSymbolicLink() || !outputStats.isFile() || !readFileSync(outputPath).equals(contents)) {
        invalidArtifact(`existing runtime public asset ${relativePath} does not match its source`);
      }
      continue;
    }
    writeFileSync(outputPath, contents, {flag: 'wx'});
  }
  return files.length;
}

function assertPrivateBackgroundAsset(contents) {
  const [{name, size, sha256}] = PRIVATE_BACKGROUND_ASSETS;
  const digest = createHash('sha256').update(contents).digest('hex');
  if(contents.length !== size || digest !== sha256) {
    invalidArtifact(`background image ${name} does not match the pinned reviewed bytes`);
  }
}

function readRequiredPrivateBackground(sourceDirectory, canonicalSourceDirectory, name) {
  if(!PRIVATE_BACKGROUND_ASSET_SET.has(name) || name.includes('/') || name.includes('\\')) {
    invalidArtifact('background image name is invalid or unreviewed');
  }
  const file = resolve(sourceDirectory, name);
  if(dirname(file) !== resolve(sourceDirectory)) {
    invalidArtifact('background image path escapes the approved directory');
  }

  let stats;
  try {
    stats = lstatSync(file);
  } catch(cause) {
    if(cause?.code === 'ENOENT') {
      invalidArtifact(`required background image ${name} is missing`);
    }
    throw cause;
  }
  if(stats.isSymbolicLink() || !stats.isFile() || stats.size === 0) {
    invalidArtifact(`required background image ${name} is empty or not a regular file`);
  }
  accessSync(file, constants.R_OK);
  const canonicalFile = realpathSync(file);
  if(dirname(canonicalFile) !== canonicalSourceDirectory || canonicalFile !== resolve(canonicalSourceDirectory, name)) {
    invalidArtifact('background image path escapes the approved directory');
  }

  const contents = readFileSync(file);
  if(contents.length === 0) {
    invalidArtifact(`required background image ${name} is empty`);
  }
  assertPrivateBackgroundAsset(contents);
  return contents;
}

function privateArtifactBackgroundDirectory(directory) {
  const artifactDirectory = resolve(directory);
  const assetsDirectory = resolve(artifactDirectory, 'assets');
  const imageDirectory = resolve(assetsDirectory, 'img');
  ensurePrivateArtifactDirectory(artifactDirectory, 'background image');
  ensurePrivateArtifactDirectory(assetsDirectory, 'background image');
  ensurePrivateArtifactDirectory(imageDirectory, 'background image');
  return imageDirectory;
}

function auditPrivateArtifactBackgroundOutputInventory(imageDirectory) {
  const visit = (directory, relativeDirectory) => {
    for(const entry of readdirSync(directory, {withFileTypes: true})) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const outputPath = resolve(directory, entry.name);
      if(entry.isSymbolicLink()) {
        invalidArtifact('background image output contains a symbolic link');
      }
      if(entry.isDirectory()) {
        if(relativePath !== 'emoji') {
          invalidArtifact(`background image output contains an unreviewed directory ${relativePath}`);
        }
        visit(outputPath, relativePath);
        continue;
      }
      if(!entry.isFile() || !isPrivateRuntimeAssetPath(`assets/img/${relativePath}`)) {
        invalidArtifact(`background image output contains an unreviewed or non-regular entry ${relativePath}`);
      }
    }
  };
  visit(imageDirectory, '');
}

export function includePrivateArtifactBackground(rootDirectory, directory) {
  if(PRIVATE_BACKGROUND_ASSETS.length !== 1 || PRIVATE_BACKGROUND_ASSET_SET.size !== 1 ||
    PRIVATE_BACKGROUND_ASSETS[0].name !== 'pattern.svg') {
    invalidArtifact('background image allowlist is invalid');
  }

  const sourceDirectory = resolve(rootDirectory, PRIVATE_BACKGROUND_SOURCE_DIRECTORY);
  let sourceDirectoryStats;
  try {
    sourceDirectoryStats = lstatSync(sourceDirectory);
  } catch(cause) {
    if(cause?.code === 'ENOENT') {
      invalidArtifact('approved background image source directory is missing or invalid');
    }
    throw cause;
  }
  if(sourceDirectoryStats.isSymbolicLink() || !sourceDirectoryStats.isDirectory()) {
    invalidArtifact('approved background image source directory is missing or invalid');
  }
  const canonicalRootDirectory = realpathSync(rootDirectory);
  const canonicalSourceDirectory = realpathSync(sourceDirectory);
  if(canonicalSourceDirectory !== resolve(canonicalRootDirectory, PRIVATE_BACKGROUND_SOURCE_DIRECTORY)) {
    invalidArtifact('approved background image source directory escapes the repository root');
  }
  const contents = PRIVATE_BACKGROUND_ASSETS.map(({name}) => [
    name,
    readRequiredPrivateBackground(sourceDirectory, canonicalSourceDirectory, name)
  ]);
  const imageDirectory = privateArtifactBackgroundDirectory(directory);
  auditPrivateArtifactBackgroundOutputInventory(imageDirectory);
  for(const [name, bytes] of contents) {
    const outputPath = resolve(imageDirectory, name);
    if(dirname(outputPath) !== imageDirectory) {
      invalidArtifact('background image output path escapes the artifact directory');
    }
    if(existsSync(outputPath)) {
      const outputStats = lstatSync(outputPath);
      if(outputStats.isSymbolicLink() || !outputStats.isFile() || !readFileSync(outputPath).equals(bytes)) {
        invalidArtifact('existing background image output does not match its approved source');
      }
      continue;
    }
    writeFileSync(outputPath, bytes, {flag: 'wx'});
  }
}

function auditPrivateArtifactFonts(directory) {
  const fontsDirectory = resolve(directory, 'assets', 'fonts');
  const stats = lstatSync(fontsDirectory);
  if(stats.isSymbolicLink() || !stats.isDirectory()) {
    invalidArtifact('font output directory is missing or invalid');
  }

  const entries = readdirSync(fontsDirectory, {withFileTypes: true});
  if(entries.length !== PRIVATE_FONT_ASSETS.length || entries.some((entry) =>
    !PRIVATE_FONT_ASSET_SET.has(entry.name) || !entry.isFile()
  )) {
    invalidArtifact('font output does not match the reviewed allowlist');
  }

  for(const name of PRIVATE_FONT_ASSETS) {
    const file = resolve(fontsDirectory, name);
    const fileStats = lstatSync(file);
    if(fileStats.isSymbolicLink() || !fileStats.isFile() || fileStats.size === 0) {
      invalidArtifact('required font is missing, empty, or not a regular file');
    }
    accessSync(file, constants.R_OK);
    const contents = readFileSync(file);
    if(contents.length === 0) {
      invalidArtifact('required font is empty');
    }
    if(name === 'tgico.svg') {
      assertSafePrivateFontSvg(contents);
    }
  }
}

function auditPrivateArtifactBackground(directory) {
  const imageDirectory = resolve(directory, 'assets', 'img');
  let stats;
  try {
    stats = lstatSync(imageDirectory);
  } catch(cause) {
    if(cause?.code === 'ENOENT') {
      invalidArtifact('background image output directory is missing or invalid');
    }
    throw cause;
  }
  if(stats.isSymbolicLink() || !stats.isDirectory()) {
    invalidArtifact('background image output directory is missing or invalid');
  }

  for(const {name} of PRIVATE_BACKGROUND_ASSETS) {
    const file = resolve(imageDirectory, name);
    const fileStats = lstatSync(file);
    if(fileStats.isSymbolicLink() || !fileStats.isFile() || fileStats.size === 0) {
      invalidArtifact(`required background image ${name} is missing, empty, or not a regular file`);
    }
    accessSync(file, constants.R_OK);
    assertPrivateBackgroundAsset(readFileSync(file));
  }
}

function checkedPrivateRuntimeAssetPath(reference) {
  let pathname = reference.trim().split(/[?#]/)[0].replace(/[),.;}\s]+$/, '');
  if(pathname.includes('${')) return;
  if(pathname.includes('\\') || pathname.includes('\0')) {
    invalidArtifact('contains an invalid runtime public asset path');
  }
  try {
    pathname = decodeURIComponent(pathname);
  } catch{
    invalidArtifact('contains an invalid encoded runtime public asset reference');
  }
  pathname = pathname.replace(/^\/+/, '').replace(/^\.\//, '');
  if(!pathname.startsWith('assets/') && !pathname.startsWith('changelogs/')) return;
  if(!extname(pathname)) return;

  const segments = pathname.split('/');
  if(!segments.every((segment) => segment && segment !== '.' && segment !== '..')) {
    invalidArtifact(`contains an invalid runtime public asset reference ${pathname}`);
  }
  if(!isPrivateRuntimePublicAssetPath(pathname)) return pathname;
  if(!PRIVATE_RUNTIME_ASSET_EXTENSIONS.has(extname(pathname).toLowerCase())) {
    invalidArtifact(`references an unsupported runtime public asset ${pathname}`);
  }
  if(!isPrivateRuntimeAssetPath(pathname)) {
    invalidArtifact(`references an unreviewed runtime public asset ${pathname}`);
  }
  return pathname;
}

function assertPrivateRuntimeAssetExists(directory, relativePath) {
  const artifactDirectory = resolve(directory);
  const file = resolve(artifactDirectory, relativePath);
  const pathFromRoot = relative(artifactDirectory, file);
  if(pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === '.') {
    invalidArtifact(`runtime public asset reference escapes the artifact directory: ${relativePath}`);
  }

  let stats;
  try {
    stats = lstatSync(file);
  } catch(cause) {
    if(cause?.code === 'ENOENT') {
      invalidArtifact(`references a missing runtime public asset ${relativePath}`);
    }
    throw cause;
  }
  if(stats.isSymbolicLink() || !stats.isFile() || stats.size === 0) {
    invalidArtifact(`references an empty or non-regular runtime public asset ${relativePath}`);
  }
}

function privateLottieAssetNames(rootDirectory = PRIVATE_ARTIFACT_REPOSITORY_ROOT) {
  let source;
  try {
    source = readFileSync(resolve(rootDirectory, 'src/lib/lottie/lottieLoader.ts'), 'utf8');
  } catch{
    invalidArtifact('typed Lottie asset names are missing or invalid');
  }

  const match = source.match(/export\s+type\s+LottieAssetName\s*=\s*((?:\s*\|\s*'[A-Za-z0-9_-]+')+)\s*;/);
  if(!match) {
    invalidArtifact('typed Lottie asset names are missing or invalid');
  }
  const names = [...match[1].matchAll(/'([A-Za-z0-9_-]+)'/g)].map(([, name]) => name);
  if(!names.length || new Set(names).size !== names.length) {
    invalidArtifact('typed Lottie asset names are missing or invalid');
  }
  return names;
}

function privateEmojiAssetNames(rootDirectory = PRIVATE_ARTIFACT_REPOSITORY_ROOT) {
  let source;
  try {
    source = readFileSync(resolve(rootDirectory, 'src/config/emoji.ts'), 'utf8');
  } catch{
    invalidArtifact('client emoji asset names are missing or invalid');
  }

  const declarationStart = source.indexOf('export const EmojiVersions');
  const assignmentStart = source.indexOf(' = ', declarationStart);
  const declarationEnd = source.indexOf(';', assignmentStart);
  if(declarationStart === -1 || assignmentStart === -1 || declarationEnd === -1) {
    invalidArtifact('client emoji asset names are missing or invalid');
  }

  let versions;
  try {
    versions = JSON.parse(source.slice(assignmentStart + 3, declarationEnd));
  } catch{
    invalidArtifact('client emoji asset names are missing or invalid');
  }
  if(!versions || typeof versions !== 'object' || Array.isArray(versions)) {
    invalidArtifact('client emoji asset names are missing or invalid');
  }

  const names = new Set();
  for(const entries of Object.values(versions)) {
    if(!entries || typeof entries !== 'object' || Array.isArray(entries)) {
      invalidArtifact('client emoji asset names are missing or invalid');
    }
    for(const [name, code] of Object.entries(entries)) {
      if(!/^[0-9a-f]+(?:-[0-9a-f]+)*$/i.test(name) || !Number.isSafeInteger(code) || code < 0) {
        invalidArtifact('client emoji asset names are missing or invalid');
      }
      names.add(`${name}.png`);
    }
  }
  if(!names.size) {
    invalidArtifact('client emoji asset names are missing or invalid');
  }
  return [...names].sort();
}

function privateDynamicRuntimeAssetPaths(name, rootDirectory, audioAssetNames) {
  switch(name) {
    case 'changelogs':
      return privateChangelogAssetNames(rootDirectory).map((assetName) => `changelogs/${assetName}`);
    case 'lottie':
      return privateLottieAssetNames(rootDirectory).map((assetName) => `assets/tgs/${assetName}.json`);
    case 'audio':
      if(!audioAssetNames.size) {
        invalidArtifact('contains a dynamic audio path without client audio asset names');
      }
      return [...audioAssetNames].sort().map((assetName) => `assets/audio/${assetName}`);
    case 'emoji':
      return privateEmojiAssetNames(rootDirectory).map((assetName) => `assets/img/emoji/${assetName}`);
    case 'images':
      return [...PRIVATE_RUNTIME_IMAGE_ASSETS].map((assetName) => `assets/img/${assetName}`);
    default:
      invalidArtifact('dynamic runtime public asset reference is unreviewed');
  }
}

export function auditPrivateArtifactRuntimeAssets(directory, rootDirectory = PRIVATE_ARTIFACT_REPOSITORY_ROOT) {
  const files = artifactFiles(directory);
  const sourceExtensions = new Set(['.css', '.html', '.js', '.json', '.mjs', '.svg', '.webmanifest', '.xml']);
  let referenceCount = 0;
  const dynamicAssetFamilies = new Set();
  const audioAssetNames = new Set();
  let expectedChangelogAssetPaths;
  for(const file of files) {
    const relativePath = relative(directory, file).split(sep).join('/');
    if(relativePath.startsWith('changelogs/')) {
      expectedChangelogAssetPaths ||= new Set(privateChangelogAssetNames(rootDirectory).map((name) => `changelogs/${name}`));
      if(!expectedChangelogAssetPaths.has(relativePath)) {
        invalidArtifact(`contains an unreviewed runtime changelog ${relativePath}`);
      }
    }
    if(isPrivateRuntimePublicAssetPath(relativePath) && !isPrivateRuntimeAssetPath(relativePath)) {
      invalidArtifact(`contains an unreviewed or non-static runtime asset ${relativePath}`);
    }

    const extension = extname(relativePath).toLowerCase();
    if(!sourceExtensions.has(extension)) continue;
    const contents = readFileSync(file, 'utf8');
    if(extension === '.js' || extension === '.mjs') {
      PRIVATE_RUNTIME_AUDIO_ASSET_NAME_PATTERN.lastIndex = 0;
      for(const match of contents.matchAll(PRIVATE_RUNTIME_AUDIO_ASSET_NAME_PATTERN)) {
        audioAssetNames.add(match[2]);
      }
    }
    for(const {name, pattern} of PRIVATE_DYNAMIC_RUNTIME_ASSET_REFERENCE_PATTERNS) {
      if(pattern.test(contents)) dynamicAssetFamilies.add(name);
    }
    PRIVATE_RUNTIME_ASSET_REFERENCE_PATTERN.lastIndex = 0;
    for(const match of contents.matchAll(PRIVATE_RUNTIME_ASSET_REFERENCE_PATTERN)) {
      const pathname = checkedPrivateRuntimeAssetPath(match[1] || match[2]);
      if(!pathname) continue;
      assertPrivateRuntimeAssetExists(directory, pathname);
      ++referenceCount;
    }

    PRIVATE_ROOT_RUNTIME_ASSET_REFERENCE_PATTERN.lastIndex = 0;
    for(const match of contents.matchAll(PRIVATE_ROOT_RUNTIME_ASSET_REFERENCE_PATTERN)) {
      if(!PRIVATE_ROOT_RUNTIME_ASSETS.includes(match[1])) {
        invalidArtifact(`references an unreviewed runtime public asset ${match[1]}`);
      }
      assertPrivateRuntimeAssetExists(directory, match[1]);
      ++referenceCount;
    }
  }

  for(const name of dynamicAssetFamilies) {
    for(const pathname of privateDynamicRuntimeAssetPaths(name, rootDirectory, audioAssetNames)) {
      assertPrivateRuntimeAssetExists(directory, pathname);
      ++referenceCount;
    }
  }

  return {assetCount: files.filter((file) =>
    isPrivateRuntimeAssetPath(relative(directory, file).split(sep).join('/'))
  ).length, referenceCount};
}

function artifactFiles(directory) {
  const files = [];
  const visit = (current) => {
    for(const entry of readdirSync(current, {withFileTypes: true})) {
      const file = resolve(current, entry.name);
      if(entry.isDirectory()) {
        visit(file);
      } else if(entry.isFile()) {
        files.push(file);
      } else {
        invalidArtifact('contains a non-regular output entry');
      }
    }
  };

  if(!existsSync(directory) || !statSync(directory).isDirectory()) {
    invalidArtifact('directory is missing');
  }
  visit(resolve(directory));
  return files.sort((left, right) => relative(directory, left).localeCompare(relative(directory, right)));
}

export function computePrivateArtifactDigest(directory) {
  const hash = createHash('sha256');
  for(const file of artifactFiles(directory)) {
    const relativePath = relative(directory, file).split(sep).join('/');
    if(relativePath === PRIVATE_ARTIFACT_MANIFEST) continue;
    const contents = readFileSync(file);
    hash.update(relativePath + '\0' + contents.length + '\0');
    hash.update(contents);
    hash.update('\0');
  }
  return 'sha256:' + hash.digest('hex');
}

function normalizedText(contents) {
  return contents.toString('utf8');
}

function allPrivateWssUrls(text) {
  return [...text.matchAll(PRIVATE_WSS_URL)].map((match) => match[0].replace(/[),.;}]+$/, ''));
}

function assertPrivateEndpoint(endpoint, label) {
  if(typeof endpoint !== 'string' || !/^wss:\/\/[^/]/i.test(endpoint)) {
    invalidArtifact(`${label} is not normalized`);
  }

  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch{
    invalidArtifact(`${label} is not normalized`);
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  parsed.hostname = hostname;
  if(parsed.protocol !== 'wss:' || !hostname || parsed.username || parsed.password ||
    parsed.search || parsed.hash || hostname === 'telegram.org' || hostname.endsWith('.telegram.org') ||
    parsed.href !== endpoint) {
    invalidArtifact(`${label} is not normalized`);
  }
}

function assertManifestShape(manifest) {
  if(!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    invalidArtifact('manifest is not an object');
  }

  const fields = ['mode', 'endpoint', 'fingerprint', 'sourceCommit', 'artifactDigest'];
  if(JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(fields.sort())) {
    invalidArtifact('manifest fields are incomplete or unexpected');
  }
  if(manifest.mode !== 'private') {
    invalidArtifact('manifest mode is not private');
  }
  assertPrivateEndpoint(manifest.endpoint, 'manifest endpoint');
  if(typeof manifest.fingerprint !== 'string' || !/^[0-9a-f]{16}$/.test(manifest.fingerprint)) {
    invalidArtifact('manifest fingerprint is invalid');
  }
  if(typeof manifest.sourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(manifest.sourceCommit)) {
    invalidArtifact('manifest source commit is invalid');
  }
  if(typeof manifest.artifactDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(manifest.artifactDigest)) {
    invalidArtifact('manifest artifact digest is invalid');
  }
}

export function privateContentSecurityPolicy(endpoint) {
  assertPrivateEndpoint(endpoint, 'CSP endpoint');

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'self' https://challenges.cloudflare.com",
    "object-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    `connect-src 'self' ${endpoint}`
  ].join('; ') + ';';
}

export function verifyPrivateArtifactCsp(directory, endpoint) {
  const indexPath = resolve(directory, 'index.html');
  if(!existsSync(indexPath)) {
    invalidArtifact('index document is missing');
  }

  const expectedPolicy = privateContentSecurityPolicy(endpoint);
  const policies = readHeadContentSecurityPolicies(readFileSync(indexPath, 'utf8'));
  if(!policies.includes(expectedPolicy)) {
    invalidArtifact('index document CSP does not match the configured endpoint');
  }

  const connectSources = policies
  .flatMap((policy) => [...policy.matchAll(/connect-src\s+([^;]+)/gi)])
  .flatMap((match) => match[1].trim().split(/\s+/))
  .map((source) => source.replace(/^['"]|['"]$/g, ''))
  .filter((source) => source.startsWith('wss://'));
  if(connectSources.some((source) => source !== endpoint)) {
    invalidArtifact('index document CSP contains an unexpected WSS endpoint');
  }
}

export function auditPrivateArtifact(directory, target) {
  if(!target || target.mode !== 'private' || typeof target.endpoint !== 'string' ||
    !/^[0-9a-f]{16}$/.test(target.fingerprint)) {
    invalidArtifact('target metadata is missing');
  }
  assertPrivateEndpoint(target.endpoint, 'target endpoint');

  const files = artifactFiles(directory);
  const executableFiles = files.filter((file) => PRIVATE_EXECUTABLE_EXTENSIONS.has(file.slice(file.lastIndexOf('.'))));
  if(!executableFiles.length) {
    invalidArtifact('contains no executable client or worker artifact');
  }

  const privateUrls = new Set();
  const executablePrivateUrls = new Set();
  const mapFiles = [];
  for(const file of files) {
    const relativePath = relative(directory, file).split(sep).join('/');
    const extension = file.slice(file.lastIndexOf('.')).toLowerCase();
    const isExecutable = PRIVATE_EXECUTABLE_EXTENSIONS.has(extension);
    if(relativePath.toLowerCase().endsWith('.map')) {
      mapFiles.push(relativePath);
    }

    const contents = readFileSync(file);
    const scanText = contents.toString('latin1');
    if(SOURCE_MAP_DIRECTIVE.test(scanText)) {
      invalidArtifact(`contains a source map or source URL directive in ${relativePath}`);
    }

    const fontName = relativePath.slice(relativePath.lastIndexOf('/') + 1);
    const isBinaryFont = relativePath.startsWith('assets/fonts/') &&
      PRIVATE_FONT_ASSET_SET.has(fontName) && fontName !== 'tgico.svg';
    if(isBinaryFont) continue;

    if(PRIVATE_KEY_BLOCK.test(scanText)) {
      invalidArtifact(`contains private key material in ${relativePath}`);
    }
    if(CLEAR_TEXT_WEBSOCKET.test(scanText)) {
      invalidArtifact(`contains a cleartext WebSocket URL in ${relativePath}`);
    }
    if(OFFICIAL_MT_PROTO_ROUTE.test(scanText) || OFFICIAL_MT_PROTO_DYNAMIC_ROUTE.test(scanText) ||
      OFFICIAL_MT_PROTO_DC_HOST.test(scanText)) {
      invalidArtifact(`contains an official Telegram MTProto route in ${relativePath}`);
    }
    if(OFFICIAL_MT_PROTO_IP.test(scanText) || OFFICIAL_MT_PROTO_IPV6.test(scanText)) {
      invalidArtifact(`contains an official Telegram MTProto IP route in ${relativePath}`);
    }
    if(HTTP_MTPROTO_ROUTE.test(scanText)) {
      invalidArtifact(`contains an HTTP MTProto transport in ${relativePath}`);
    }

    const lower = scanText.toLowerCase();
    for(const fingerprint of TRUSTED_MT_PROTO_FINGERPRINTS) {
      if(lower.includes(fingerprint)) {
        invalidArtifact(`contains a trusted Telegram RSA fingerprint in ${relativePath}`);
      }
    }
    for(const modulus of TRUSTED_MT_PROTO_MODULI) {
      if(lower.includes(modulus)) {
        invalidArtifact(`contains a trusted Telegram RSA public key in ${relativePath}`);
      }
    }
    for(const endpoint of allPrivateWssUrls(scanText)) {
      privateUrls.add(endpoint);
      if(isExecutable) executablePrivateUrls.add(endpoint);
    }
  }

  if(mapFiles.length) {
    invalidArtifact(`contains a source map file in ${mapFiles[0]}`);
  }
  if(!executablePrivateUrls.has(target.endpoint)) {
    invalidArtifact('does not contain its configured WSS endpoint');
  }
  const unexpected = [...privateUrls].filter((endpoint) => endpoint !== target.endpoint);
  if(unexpected.length) {
    invalidArtifact('contains a second private MTProto target');
  }
  if(lowercaseFiles(files, directory).includes(target.fingerprint.toLowerCase()) === false) {
    invalidArtifact('does not contain its configured RSA fingerprint');
  }
  auditPrivateArtifactFonts(directory);
  auditPrivateArtifactBackground(directory);
  auditPrivateArtifactRuntimeAssets(directory);
}

export function verifyPrivateUsernameSignIn(directory) {
  const executableFiles = artifactFiles(directory)
  .filter((file) => PRIVATE_EXECUTABLE_EXTENSIONS.has(file.slice(file.lastIndexOf('.')).toLowerCase()));
  if(!executableFiles.some((file) => readFileSync(file, 'utf8').includes('Sign in with your username'))) {
    invalidArtifact('does not contain the username sign-in marker in executable JavaScript');
  }
}

function lowercaseFiles(files, directory) {
  return files
  .filter((file) => PRIVATE_EXECUTABLE_EXTENSIONS.has(file.slice(file.lastIndexOf('.'))))
  .map((file) => normalizedText(readFileSync(file)).toLowerCase())
  .join('\n');
}

function sourceCommit(rootDirectory) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {cwd: rootDirectory, encoding: 'utf8'}).trim();
  } catch(cause) {
    throw new Error('[MT] unable to determine private artifact source commit', {cause});
  }
}

export function verifyPrivateArtifactManifest(directory, expectedTarget) {
  const manifestPath = resolve(directory, PRIVATE_ARTIFACT_MANIFEST);
  if(!existsSync(manifestPath)) {
    invalidArtifact('manifest is missing');
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch(cause) {
    throw new Error('[MT] private artifact manifest is invalid', {cause});
  }
  assertManifestShape(manifest);

  if(expectedTarget && (expectedTarget.mode !== manifest.mode ||
    expectedTarget.endpoint !== manifest.endpoint || expectedTarget.fingerprint !== manifest.fingerprint)) {
    invalidArtifact('manifest does not match the validated target');
  }
  const digest = computePrivateArtifactDigest(directory);
  if(digest !== manifest.artifactDigest) {
    invalidArtifact('digest does not match the completed artifact');
  }

  auditPrivateArtifact(directory, {
    mode: 'private',
    endpoint: manifest.endpoint,
    fingerprint: manifest.fingerprint
  });
  return manifest;
}

export function writePrivateArtifactManifest(directory, target, rootDirectory) {
  if(!target || target.mode !== 'private' || !target.routeLock ||
    target.routeLock.mode !== PRIVATE_ROUTE_LOCK.mode || target.routeLock.endpoint !== target.endpoint ||
    target.routeLock.transport !== PRIVATE_ROUTE_LOCK.transport ||
    JSON.stringify(target.routeLock.dcIds) !== JSON.stringify(PRIVATE_ROUTE_LOCK.dcIds) ||
    JSON.stringify(target.routeLock.connectionTypes) !== JSON.stringify(PRIVATE_ROUTE_LOCK.connectionTypes)) {
    invalidArtifact('target and route-lock metadata are inconsistent');
  }

  includePrivateArtifactFonts(rootDirectory, directory);
  includePrivateArtifactBackground(rootDirectory, directory);
  auditPrivateArtifact(directory, target);
  const manifest = {
    mode: 'private',
    endpoint: target.endpoint,
    fingerprint: target.fingerprint,
    sourceCommit: sourceCommit(rootDirectory),
    artifactDigest: computePrivateArtifactDigest(directory)
  };
  assertManifestShape(manifest);
  writeFileSync(resolve(directory, PRIVATE_ARTIFACT_MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
  verifyPrivateArtifactManifest(directory, target);
  return manifest;
}

export function createPrivateArtifactPlugin(rootDirectory, target) {
  return {
    name: 'private-mtproto-artifact',
    apply: 'build',
    transformIndexHtml(html) {
      return {
        html,
        tags: [{
          tag: 'meta',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content: privateContentSecurityPolicy(target.endpoint)
          },
          injectTo: 'head-prepend'
        }]
      };
    },
    writeBundle(options) {
      const directory = resolve(rootDirectory, options.dir || 'dist');
      includePrivateArtifactRuntimeAssets(rootDirectory, directory);
      writePrivateArtifactManifest(directory, target, rootDirectory);
    }
  };
}
