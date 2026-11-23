import { env } from './env';
import { AppError } from '../utils/errors';

export const features = {
  email: env.FEATURE_EMAIL,
  oauth: env.FEATURE_OAUTH,
  emailQueue: env.FEATURE_EMAIL_QUEUE,
  codeSandbox: env.FEATURE_CODE_SANDBOX,
  memory: env.FEATURE_MEMORY && !!env.GEMINI_API_KEY,
  uploads: env.FEATURE_UPLOADS && !!env.BUCKET_NAME && !!env.UPLOADS_PUBLIC_BASE_URL,
} as const;

export type FeatureName = keyof typeof features;

export function requireFeature(feature: FeatureName): void {
  if (!features[feature]) {
    throw new AppError(
      'FEATURE_DISABLED',
      'This feature is currently unavailable.',
      503
    );
  }
}
