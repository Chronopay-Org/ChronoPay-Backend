import fs from 'fs';
import path from 'path';
const configPath = path.join(process.cwd(), 'ops', 'grafana-config.json');
export async function uploadDashboards(apiUrl, apiKey) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const targetUrl = apiUrl || config.url || 'http://localhost:3000';
    const dashboardsDir = path.join(process.cwd(), config.dashboardFolder);
    const files = fs.readdirSync(dashboardsDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
        const filePath = path.join(dashboardsDir, file);
        const dashboard = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const payload = {
            dashboard,
            folderId: 0,
            overwrite: true,
            message: 'Uploaded via dashboards-as-code'
        };
        const headers = {
            'Content-Type': 'application/json'
        };
        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }
        try {
            const res = await fetch(`${targetUrl}/api/dashboards/db`, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
            });
            if (!res.ok) {
                const errorText = await res.text();
                throw new Error(`Failed to upload ${file}: ${res.status} ${res.statusText} - ${errorText}`);
            }
            const result = await res.json();
            console.log(`✅ Successfully uploaded ${file} (version ${result.version})`);
        }
        catch (err) {
            console.error(`Error uploading ${file}:`, err);
            throw err;
        }
    }
}
if (process.argv[1] && process.argv[1].endsWith('upload-dashboards.ts')) {
    const apiUrl = process.env.GRAFANA_URL;
    const apiKey = process.env.GRAFANA_API_KEY;
    uploadDashboards(apiUrl, apiKey).catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
