#!/usr/bin/env python3
"""仅在回环地址提供游戏与 WebAssembly 资源。"""
import argparse
import errno
import functools
import http.client
import http.server
import pathlib
import threading
import urllib.parse
import webbrowser

ROOT = pathlib.Path(__file__).resolve().parent


def same_game_is_running(port):
    """直接核验回环端口的隔离响应头与本地游戏正文，不跟随重定向。"""
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
    try:
        expected = (ROOT / '游戏.html').read_bytes()
        connection.request('GET', '/' + urllib.parse.quote('游戏.html'))
        response = connection.getresponse()
        return (response.status == 200
                and response.getheader('Cross-Origin-Opener-Policy') == 'same-origin'
                and response.getheader('Cross-Origin-Embedder-Policy') == 'require-corp'
                and response.read(len(expected) + 1) == expected)
    except (OSError, http.client.HTTPException):
        return False
    finally:
        connection.close()


class GameHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.wasm': 'application/wasm', '.mjs': 'text/javascript; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
    }

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def do_GET(self):
        if not self.safe_path():
            self.send_error(403, 'Forbidden')
            return
        super().do_GET()

    def do_HEAD(self):
        if not self.safe_path():
            self.send_error(403, 'Forbidden')
            return
        super().do_HEAD()

    def safe_path(self):
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        if '\\' in path or '\x00' in path or '..' in pathlib.PurePosixPath(path).parts:
            return False
        requested = (ROOT / path.lstrip('/')).resolve()
        return requested == ROOT or ROOT in requested.parents

    def list_directory(self, path):
        self.send_error(403, 'Directory listing disabled')
        return None


def main():
    parser = argparse.ArgumentParser(description='启动 seekdb 海战的本地静态服务')
    parser.add_argument('--port', type=int, default=8768)
    parser.add_argument('--open', action='store_true', help='自动打开游戏页面')
    options = parser.parse_args()
    handler = functools.partial(GameHandler, directory=str(ROOT))
    url = f'http://127.0.0.1:{options.port}/' + urllib.parse.quote('游戏.html')
    try:
        server = http.server.ThreadingHTTPServer(('127.0.0.1', options.port), handler)
    except OSError as error:
        if error.errno == errno.EADDRINUSE and options.open and same_game_is_running(options.port):
            print(f'检测到相同游戏服务，复用现有页面：{url}', flush=True)
            webbrowser.open(url)
            return
        raise SystemExit(f'无法启动本地服务：{error}。可用 --port 指定其他端口。')
    print(f'游戏地址：{url}\n关闭此窗口或按 Ctrl+C 停止服务。', flush=True)
    if options.open:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
