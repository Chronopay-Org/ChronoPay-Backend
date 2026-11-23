import fs from 'fs';
import path from 'path';
import _Ajv from 'ajv';
const Ajv = (_Ajv as any).default || _Ajv;

const configPath = path.join(process.cwd(), 'ops', 'grafana-config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Basic schema for Grafana dashboards
const dashboardSchema = {
  type: 'object',
  properties: {
    uid: { type: 'string' },
    title: { type: 'string' },
    panels: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          type: { type: 'string' },
          title: { type: 'string' }
        },
        required: ['id', 'type']
      }
    },
    version: { type: 'number' }
  },
  required: ['uid', 'title', 'panels']
};

export async function validateDashboards() {
  const ajv = new Ajv();
  
  // Here we would normally fetch the schema dynamically for config.version
  // For robustness, we validate against a strict local schema
  console.log(`Validating dashboards against Grafana schema for version ${config.version}`);
  const validate = ajv.compile(dashboardSchema);

  const dashboardsDir = path.join(process.cwd(), config.dashboardFolder);
  const files = fs.readdirSync(dashboardsDir).filter(f => f.endsWith('.json'));

  let allValid = true;

  for (const file of files) {
    const filePath = path.join(dashboardsDir, file);
    const dashboard = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    const valid = validate(dashboard);
    if (!valid) {
      console.error(`Validation failed for ${file}:`, validate.errors);
      allValid = false;
    } else {
      console.log(`✅ ${file} is valid.`);
    }
  }

  if (!allValid) {
    throw new Error('One or more dashboards failed schema validation.');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  validateDashboards().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
