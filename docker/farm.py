"""Small CPU container contract client, using only Python's standard library."""
import json
import os
import pathlib
import urllib.request


class Farm:
    def __init__(self):
        self.url = os.environ['FARM_API_URL'].rstrip('/')
        result = self.request('/tasks/bootstrap', {
            'jobId': os.environ['FARM_JOB_ID'],
            'taskIndex': int(os.environ.get('CLOUD_RUN_TASK_INDEX', '0')),
            'attempt': int(os.environ.get('CLOUD_RUN_TASK_ATTEMPT', '0')),
            'bootstrap': os.environ['FARM_BOOTSTRAP'],
        })
        self.token = result['token']
        self.params = result['params']

    def request(self, path, body):
        headers = {'Content-Type': 'application/json'}
        if hasattr(self, 'token'):
            headers['Authorization'] = 'Bearer ' + self.token
        request = urllib.request.Request(self.url + path, json.dumps(body).encode(), headers)
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.load(response)

    def output(self, path, mime_type, role=None):
        file = pathlib.Path(path)
        body = {'name': file.name, 'mimeType': mime_type, 'bytes': file.stat().st_size}
        if role:
            body['role'] = role
        upload = self.request('/tasks/outputs/upload-url', body)
        headers = upload.get('headers', {})
        with file.open('rb') as stream:
            request = urllib.request.Request(upload['url'], stream.read(), headers, method='PUT')
            with urllib.request.urlopen(request, timeout=300):
                pass
        self.request('/tasks/outputs', dict(body, uploadId=upload['uploadId']))

    def complete(self, error=None):
        self.request('/tasks/complete', {'status': 'failed' if error else 'succeeded', **({'error': str(error)[:2000]} if error else {})})


def download(url, destination):
    if not url.startswith('https://'):
        raise ValueError('Input must be an HTTPS URL; use a signed URL for private inputs')
    with urllib.request.urlopen(url, timeout=120) as response, open(destination, 'wb') as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
