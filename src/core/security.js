import fs from 'node:fs';
import path from 'node:path';

export function resolveSafePath(filePath, allowedRoots = []) {
  try {
    if (typeof filePath !== 'string' || filePath.includes('\0') ||
        filePath.split(/[\\/]/).includes('..')) throw new Error('traversal');
    const resolved = fs.realpathSync(filePath);
    const inside = allowedRoots.some(root => {
      const relative = path.relative(fs.realpathSync(root), resolved);
      return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
    });
    if (!inside || !fs.statSync(resolved).isFile()) throw new Error('outside roots');
    return { ok: true, path: resolved };
  } catch {
    return { ok: false, errorCode: 'SCOPE_DENIED', message: 'Arquivo fora das raízes autorizadas ou indisponível.' };
  }
}

export function redactSecrets(value) {
  let text = String(value ?? ''), count = 0;
  const types = new Set();
  const replace = (type, regex, transform = () => '[REDACTED]') => {
    text = text.replace(regex, (...args) => { count++; types.add(type); return transform(...args); });
  };
  // Complete PEM private key blocks (do not cross another BEGIN header).
  replace('private_key', /-----BEGIN (?:[A-Z0-9]{1,24} ){0,4}PRIVATE KEY-----(?:(?!-----BEGIN )[\s\S])*?-----END (?:[A-Z0-9]{1,24} ){0,4}PRIVATE KEY-----/g);
  // Complete PGP private key blocks.
  replace('private_key', /-----BEGIN PGP PRIVATE KEY BLOCK-----(?:(?!-----BEGIN )[\s\S])*?-----END PGP PRIVATE KEY BLOCK-----/g);
  // Truncated PEM/PGP private key blocks (missing END marker): consume headers, optional RFC 4880 blank line, and base64 key lines without swallowing later log lines.
  replace(
    'private_key',
    /-----BEGIN (?:[A-Z0-9]{1,24} ){0,4}(?:PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----(?:\r?\n[A-Za-z][A-Za-z0-9-]{1,24}: [^\r\n]{1,128})*(?:\r?\n(?=\r?\n[A-Za-z0-9+/=]{12,256}(?:\r?\n|$)))?(?:\r?\n[A-Za-z0-9+/=]{12,256})*/g
  );
  replace('basic_auth', /(\bAuthorization\s*:\s*Basic\s+)[A-Za-z0-9+/=]{4,512}/gi, (_, prefix) => `${prefix}[REDACTED]`);
  replace('bearer', /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi);
  replace('jwt', /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g);
  replace('api_key', /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,})\b/g);
  replace('slack_token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g);
  replace('aws_key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g);
  replace('github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{15,}|github_pat_[A-Za-z0-9_]{15,})\b/g);
  // Linear O(n) URL password matcher: negative lookbehind prevents quadratic backtracking on repeated delimiters.
  replace('url_password', /(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]{0,15}:\/\/[^\s/:@]{1,128}:)[^\s/@]{1,512}(@)/gi, (_, prefix, suffix) => `${prefix}[REDACTED]${suffix}`);
  // Linear O(n) assignment matcher: covers GITHUB_TOKEN/API_TOKEN/client_secret/password while preserving token_count/tokens.
  replace(
    'secret_assignment',
    /(?<![A-Za-z0-9_.-])(["']?(?:[A-Za-z0-9_.-]{0,64}(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|[_-]token)|token)["']?\s*[:=]\s*)("(?:[^"\\\r\n]|\\[\s\S])*"|'[^'\r\n]*'|[^\s,;}\]"']+)/gi,
    (whole, prefix, secret) => /\[REDACTED\]/.test(secret)
      ? (count--, `${prefix}${secret}`)
      : `${prefix}${secret.startsWith('"') ? '"[REDACTED]"' : secret.startsWith("'") ? "'[REDACTED]'" : '[REDACTED]'}`
  );
  return { text, count, types: [...types] };
}
