import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import path from 'path';

/**
 * Verify a container image using Cosign.
 * Supports dual-key rotation: COSIGN_PUBLIC_KEY (primary) and COSIGN_PUBLIC_KEY_PREV (fallback).
 */

export async function verifyImage(image: string): Promise<boolean> {
  const primaryKey = process.env.COSIGN_PUBLIC_KEY;
  const prevKey = process.env.COSIGN_PUBLIC_KEY_PREV;

  if (!primaryKey && !prevKey) {
    console.error('Error: Neither COSIGN_PUBLIC_KEY nor COSIGN_PUBLIC_KEY_PREV is set.');
    return false;
  }

  // Try primary key
  if (primaryKey) {
    const success = await runCosignVerify(image, primaryKey);
    if (success) {
      console.log(`Image ${image} successfully verified with primary key.`);
      return true;
    } else {
      console.warn(`Primary key verification failed for ${image}.`);
    }
  }

  // Try fallback key
  if (prevKey) {
    console.log(`Attempting verification with fallback key for ${image}...`);
    const success = await runCosignVerify(image, prevKey);
    if (success) {
      console.log(`Image ${image} successfully verified with fallback key.`);
      return true;
    } else {
      console.error(`Fallback key verification failed for ${image}.`);
    }
  }

  console.error(`Error: Failed to verify image ${image} with any available key.`);
  return false;
}

export function runCosignVerify(image: string, key: string): Promise<boolean> {
  return new Promise((resolve) => {
    const tempEnvKey = `TEMP_KEY_${Math.random().toString(36).substring(7)}`;
    const env = { ...process.env, [tempEnvKey]: key };

    const child = spawn('cosign', ['verify', '--key', `env://${tempEnvKey}`, image], { env });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(true);
      } else {
        resolve(false);
      }
    });

    child.on('error', () => {
      resolve(false);
    });
  });
}

// CLI execution
/* istanbul ignore next */
if (import.meta.url) {
  const currentPath = fileURLToPath(import.meta.url);
  if (process.argv[1] === currentPath) {
    const image = process.argv[2];
    if (!image) {
      console.error('Usage: tsx verify-image.ts <image>');
      process.exit(1);
    }

    verifyImage(image).then((success) => {
      if (success) {
        process.exit(0);
      } else {
        process.exit(1);
      }
    });
  }
}
