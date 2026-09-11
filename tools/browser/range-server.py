from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import os, re
class Handler(SimpleHTTPRequestHandler):
    def send_head(self):
        path=self.translate_path(self.path)
        if not os.path.isfile(path) or not self.headers.get('Range'):
            return super().send_head()
        size=os.path.getsize(path)
        match=re.fullmatch(r'bytes=(\d+)-(\d*)',self.headers['Range'])
        if not match:
            self.send_error(416); return
        start=int(match[1]); end=min(int(match[2]) if match[2] else size-1,size-1)
        if start>end:
            self.send_error(416); return
        self.send_response(206)
        self.send_header('Content-Type',self.guess_type(path))
        self.send_header('Accept-Ranges','bytes')
        self.send_header('Content-Range',f'bytes {start}-{end}/{size}')
        self.send_header('Content-Length',str(end-start+1))
        self.end_headers()
        self.remaining=end-start+1
        f=open(path,'rb'); f.seek(start); return f
    def copyfile(self,source,output):
        if not hasattr(self,'remaining'): return super().copyfile(source,output)
        while self.remaining:
            data=source.read(min(self.remaining,65536))
            if not data: break
            output.write(data); self.remaining-=len(data)
ThreadingHTTPServer(('127.0.0.1',8767),Handler).serve_forever()
