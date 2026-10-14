/** Autentikasi password dengan token sesi yang hanya divalidasi di server. */

function normalizeEmail_(email) {
  return String(email || '').trim().toLowerCase();
}

function validateEmail_(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail_(email));
}

function validatePassword_(password) {
  const value = String(password || '');
  if (value.length < CONFIG.PASSWORD_MIN_LENGTH) {
    throw new Error('Kata sandi minimal ' + CONFIG.PASSWORD_MIN_LENGTH + ' karakter.');
  }
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) {
    throw new Error('Kata sandi harus memuat huruf dan angka.');
  }
}

function bytesToHex_(bytes) {
  return bytes.map(function(value) {
    const normalized = value < 0 ? value + 256 : value;
    return ('0' + normalized.toString(16)).slice(-2);
  }).join('');
}

function hashText_(value) {
  return bytesToHex_(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value),
    Utilities.Charset.UTF_8
  ));
}

function hashPassword_(password, email) {
  const pepper = getScriptPropertyRequired_('AUTH_PEPPER');
  return bytesToHex_(Utilities.computeHmacSha256Signature(
    normalizeEmail_(email) + ':' + String(password),
    pepper,
    Utilities.Charset.UTF_8
  ));
}

function constantTimeEquals_(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    mismatch |= (a.charCodeAt(i % Math.max(a.length, 1)) || 0) ^
      (b.charCodeAt(i % Math.max(b.length, 1)) || 0);
  }
  return mismatch === 0;
}

function loginRateKey_(email) {
  return 'login:' + hashText_(normalizeEmail_(email)).slice(0, 32);
}

function getLoginState_(email) {
  const raw = CacheService.getScriptCache().get(loginRateKey_(email));
  if (!raw) return { attempts: 0, lockedUntil: 0 };
  try {
    return JSON.parse(raw);
  } catch (error) {
    return { attempts: 0, lockedUntil: 0 };
  }
}

function recordFailedLogin_(email) {
  const cache = CacheService.getScriptCache();
  const state = getLoginState_(email);
  state.attempts += 1;
  if (state.attempts >= CONFIG.MAX_LOGIN_ATTEMPTS) {
    state.lockedUntil = Date.now() + CONFIG.LOGIN_LOCK_SECONDS * 1000;
  }
  cache.put(loginRateKey_(email), JSON.stringify(state), CONFIG.LOGIN_LOCK_SECONDS);
}

function clearFailedLogin_(email) {
  CacheService.getScriptCache().remove(loginRateKey_(email));
}

function createSession_(user) {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const session = {
    email: normalizeEmail_(user.email),
    issuedAt: Date.now()
  };
  CacheService.getScriptCache().put(
    'session:' + hashText_(token),
    JSON.stringify(session),
    CONFIG.SESSION_TIMEOUT_SECONDS
  );
  return token;
}

function destroySession_(token) {
  if (token) CacheService.getScriptCache().remove('session:' + hashText_(token));
}

function publicUser_(user) {
  return {
    email: user.email,
    nama: user.nama || user.email,
    role: user.role,
    isActive: user.is_active === true,
    isAdmin: user.role === ROLES.ADMIN,
    mustChangePassword: user.must_change_password === true,
    facilityScope: {
      puskesmas: user.puskesmas || null,
      kecamatan: user.kecamatan || null,
      desa: user.desa || null,
      id_user: user.id_user || null
    }
  };
}

function requireSession_(token, options) {
  const settings = options || {};
  if (!token) throw new Error('Sesi tidak ditemukan. Silakan masuk kembali.');

  const key = 'session:' + hashText_(token);
  const raw = CacheService.getScriptCache().get(key);
  if (!raw) throw new Error('Sesi telah berakhir. Silakan masuk kembali.');

  let session;
  try {
    session = JSON.parse(raw);
  } catch (error) {
    destroySession_(token);
    throw new Error('Sesi tidak valid. Silakan masuk kembali.');
  }

  const user = getUserRecordByEmail_(session.email, false);
  if (!user || user.is_active !== true) {
    destroySession_(token);
    throw new Error('Akun tidak terdaftar atau tidak aktif.');
  }
  if (user.must_change_password === true && !settings.allowPasswordChange) {
    throw new Error('Kata sandi sementara harus diganti terlebih dahulu.');
  }

  CacheService.getScriptCache().put(key, raw, CONFIG.SESSION_TIMEOUT_SECONDS);
  return user;
}

function requireAdminSession_(token) {
  const user = requireSession_(token);
  if (user.role !== ROLES.ADMIN) {
    throw new Error('Hanya admin yang dapat melakukan operasi ini.');
  }
  return user;
}

function loginWithPassword(email, password) {
  const normalizedEmail = normalizeEmail_(email);
  const state = getLoginState_(normalizedEmail);
  if (state.lockedUntil > Date.now()) {
    throw new Error('Terlalu banyak percobaan login. Coba lagi beberapa menit lagi.');
  }
  if (!validateEmail_(normalizedEmail) || !password) {
    recordFailedLogin_(normalizedEmail);
    throw new Error('Email atau kata sandi tidak sesuai.');
  }

  const user = getUserRecordByEmail_(normalizedEmail, true);
  const candidate = hashPassword_(password, user ? user.email : normalizedEmail);
  if (!user || user.is_active !== true || !constantTimeEquals_(candidate, user.password_hash)) {
    recordFailedLogin_(normalizedEmail);
    throw new Error('Email atau kata sandi tidak sesuai.');
  }

  clearFailedLogin_(normalizedEmail);
  const token = createSession_(user);
  return { success: true, token: token, user: publicUser_(user) };
}

function validateSession(token) {
  const user = requireSession_(token, { allowPasswordChange: true });
  return { success: true, user: publicUser_(user) };
}

function logout(token) {
  destroySession_(token);
  return { success: true };
}

function changeOwnPassword(token, currentPassword, newPassword) {
  const user = requireSession_(token, { allowPasswordChange: true });
  validatePassword_(newPassword);
  const existing = getUserRecordByEmail_(user.email, true);
  const currentHash = hashPassword_(currentPassword, existing.email);
  if (!constantTimeEquals_(currentHash, existing.password_hash)) {
    throw new Error('Kata sandi saat ini tidak sesuai.');
  }
  setUserPassword_(user.email, newPassword, false);
  destroySession_(token);
  return { success: true, message: 'Kata sandi berhasil diganti. Silakan masuk kembali.' };
}
