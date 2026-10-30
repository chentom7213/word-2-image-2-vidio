import { z } from 'zod';

export const orgNameSchema = z.string().trim().min(1, '请填写组织名称').max(120, '组织名称最长 120 字');

export const inviteEmailSchema = z.string().trim().toLowerCase().email('邮箱格式不正确');

export const apiKeyNameSchema = z.string().trim().min(1, '请填写钥匙名称').max(80, '钥匙名称最长 80 字');
