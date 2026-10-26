import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('./docs/',import.meta.url));
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.woff2':'font/woff2','.webp':'image/webp','.png':'image/png','.svg':'image/svg+xml','.xml':'application/xml','.txt':'text/plain'};
http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/nemo'){res.writeHead(301,{Location:'/nemo/'});res.end();return;}
    if(!url.pathname.startsWith('/nemo/')){res.writeHead(404);res.end();return;}
    const path=decodeURIComponent(url.pathname.slice('/nemo/'.length));
    const file=resolve(root,path.endsWith('/')?path+'index.html':path||'index.html');
    if(!file.startsWith(root.endsWith(sep)?root:root+sep)){res.writeHead(403);res.end();return;}
    const body=await readFile(file);res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(body);
  }catch{res.writeHead(404);res.end();}
}).listen(8794,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:8794/nemo/'));
