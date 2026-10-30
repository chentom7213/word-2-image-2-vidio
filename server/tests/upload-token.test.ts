import { describe, expect, it } from 'vitest';
import { createUploadToken, verifyUploadToken } from '../src/services/upload-token.js';

const claims = {
  userId: 'user-1',
  orgId: 'org-1',
  objectKey: 'uploads/user-1/example.png',
  filename: '原始文件名.png',
  mime: 'image/png',
  size: 1234,
};

describe('asset upload confirmation token', () => {
  it('round-trips bound upload metadata before expiry', () => {
    const token = createUploadToken(claims, 60, 1_000);
    expect(verifyUploadToken(token, 1_059)).toEqual({ ...claims, expires: 1_060 });
  });

  it('rejects tampering and expiry', () => {
    const token = createUploadToken(claims, 60, 1_000);
    expect(verifyUploadToken(`${token.slice(0, -1)}x`, 1_001)).toBeNull();
    expect(verifyUploadToken(token, 1_061)).toBeNull();
  });
});
