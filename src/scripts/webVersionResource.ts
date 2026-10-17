import type {Plugin} from 'vite';
import {LEGACY_WEB_VERSION_RESOURCE_PATH, WEB_VERSION_RESOURCE_PATH} from '../lib/webVersion';

const versionResourcePaths = [WEB_VERSION_RESOURCE_PATH, LEGACY_WEB_VERSION_RESOURCE_PATH];

export default function webVersionResourcePlugin(): Plugin {
  let versionFull: string;

  return {
    name: 'tweb:web-version-resource',
    configResolved(config) {
      versionFull = config.env.VITE_VERSION_FULL;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if(!versionResourcePaths.includes(request.url?.split('?')[0] ?? '')) {
          return next();
        }

        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.end(versionFull);
      });
    },
    generateBundle() {
      for(const path of versionResourcePaths) {
        this.emitFile({
          type: 'asset',
          fileName: path.slice(1),
          source: versionFull
        });
      }
    }
  };
}
