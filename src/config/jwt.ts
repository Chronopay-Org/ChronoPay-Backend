import jwt from 'jsonwebtoken';

interface JwtConfig {
  secret: string;
  issuer: string;
  audience: string;
  leewaySeconds: number;
  algorithms: jwt.Algorithm[];
}

const parseAlgorithms = (algorithmsStr: string): jwt.Algorithm[] => {
  const algorithms = algorithmsStr.split(',').map(a => a.trim()).filter(a => a.length > 0);
  if (algorithms.length === 0) throw new Error('Invalid JWT_ALGORITHMS: must contain at least one algorithm');
  const validAlgorithms: string[] = ['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512'];
  for (const algo of algorithms) {
    if (!validAlgorithms.includes(algo)) throw new Error(`Invalid JWT_ALGORITHMS: ${algo} is not a valid algorithm`);
  }
  return algorithms as jwt.Algorithm[];
};

const initializeJwtConfig = (): JwtConfig => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('Missing required environment variable: JWT_SECRET');

  const issuer = process.env.JWT_ISSUER;
  if (!issuer) throw new Error('Missing required environment variable: JWT_ISSUER');

  const audience = process.env.JWT_AUDIENCE;
  if (!audience) throw new Error('Missing required environment variable: JWT_AUDIENCE');

  const leewayStr = process.env.JWT_LEEWAY;
  const leewaySeconds = leewayStr !== undefined ? parseInt(leewayStr, 10) : 0;
  if (isNaN(leewaySeconds) || leewaySeconds < 0) throw new Error('Invalid JWT_LEEWAY: must be a non-negative integer');

  const algorithmsStr = process.env.JWT_ALGORITHMS;
  if (!algorithmsStr) throw new Error('Missing required environment variable: JWT_ALGORITHMS');
  const algorithms = parseAlgorithms(algorithmsStr);

  return { secret, issuer, audience, leewaySeconds, algorithms };
};

let cachedConfig: JwtConfig | null = null;

export function getJwtConfig(): JwtConfig {
  if (!cachedConfig) {
    cachedConfig = initializeJwtConfig();
  }
  return cachedConfig;
}
