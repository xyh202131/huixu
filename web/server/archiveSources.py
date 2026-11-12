import bz2
import gzip
import io
import lzma
import os
import shutil
import stat
import subprocess
import tarfile
import tempfile
import threading
import time
import zipfile
from collections import Counter
from pathlib import Path, PurePosixPath


MAX_EXPANDED = 64 * 1024 * 1024
MAX_MEMBER = 12 * 1024 * 1024
MAX_ENTRIES = 300
MAX_DEPTH = 3
TAR_COMPRESSION = {'.tar.gz': gzip.open, '.tgz': gzip.open, '.tar.bz2': bz2.BZ2File,
                   '.tbz2': bz2.BZ2File, '.tar.xz': lzma.LZMAFile, '.txz': lzma.LZMAFile}
STREAM_COMPRESSION = {'.gz': gzip.open, '.bz2': bz2.BZ2File, '.xz': lzma.LZMAFile}
ARCHIVES = set(TAR_COMPRESSION) | set(STREAM_COMPRESSION) | {'.zip', '.tar', '.7z', '.rar'}


class ArchiveProblem(Exception):
    pass


def extension(name):
    lower = name.lower()
    return next((suffix for suffix in ('.tar.gz', '.tar.bz2', '.tar.xz') if lower.endswith(suffix)), PurePosixPath(lower).suffix)


def safe_path(path):
    parts = path.replace('\\', '/').split('/')
    if len(path) > 300 or any(ord(char) < 32 or 0xD800 <= ord(char) <= 0xDFFF for char in path):
        return None
    if not parts[0] or path.startswith('@') or ':' in path or '..' in parts:
        return None
    return '/'.join(part for part in parts if part not in ('.', '')) or None


def read_limited(stream, maximum):
    content = stream.read(maximum + 1)
    if len(content) > maximum:
        raise ArchiveProblem('解压体积超出上限')
    return content


def zip_members(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        duplicates = Counter(item.orig_filename for item in entries)
        for item in entries:
            if item.is_dir():
                continue
            name = item.orig_filename
            if not item.flag_bits & 0x800 and any(ord(char) > 127 for char in name):
                try:
                    decoded = name.encode('cp437').decode('gb18030')
                    if any('\u4e00' <= char <= '\u9fff' for char in decoded):
                        name = decoded
                except UnicodeError:
                    pass
            mode = stat.S_IFMT(item.external_attr >> 16)
            issue = ''
            if item.flag_bits & 1:
                issue = '成员已加密'
            elif mode not in (0, stat.S_IFREG):
                issue = '链接或特殊成员已跳过'
            elif duplicates[item.orig_filename] > 1:
                issue = '包内路径重复'

            def read(maximum):
                with archive.open(item) as stream:
                    return read_limited(stream, maximum)

            yield name, item.file_size, issue, read


def tar_members(data):
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
        for item in archive:
            if item.isdir():
                continue

            def read(maximum):
                with archive.extractfile(item) as stream:
                    return read_limited(stream, maximum)

            yield item.name, item.size, '' if item.isfile() and not item.issparse() else '链接或特殊成员已跳过', read


def find_7z():
    configured = os.environ.get('HUIXU_MEMORY_7Z')
    if configured:
        return configured
    found = shutil.which('7z') or shutil.which('7zz')
    if found:
        return found
    if os.name == 'nt':
        for folder in ('ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)'):
            base = os.environ.get(folder)
            candidate = Path(base) / '7-Zip' / '7z.exe' if base else None
            if candidate and candidate.is_file():
                return str(candidate)
    raise ArchiveProblem('需要本机 7-Zip 才能读取此格式')


def run_7z(executable, args, maximum, deadline):
    timeout = min(20, deadline - time.monotonic())
    if timeout <= 0:
        raise ArchiveProblem('压缩包处理超时')
    try:
        child = subprocess.Popen([executable, *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except OSError as error:
        raise ArchiveProblem('无法启动本机 7-Zip') from error
    with child:
        timer = threading.Timer(timeout, child.kill)
        timer.start()
        try:
            data = read_limited(child.stdout, maximum)
            if child.wait() != 0:
                raise ArchiveProblem('压缩包或成员无法读取，可能已加密或损坏')
            return data
        finally:
            timer.cancel()
            if child.poll() is None:
                child.kill()


def seven_zip_members(data, suffix, deadline):
    executable = find_7z()
    with tempfile.TemporaryDirectory(prefix='huixu-archive-') as directory:
        path = Path(directory) / ('archive' + suffix)
        path.write_bytes(data)
        listing = run_7z(executable, ['l', '-slt', '-sccUTF-8', '-bd', '--', str(path)], 1024 * 1024, deadline)
        entries = []
        for block in listing.decode('utf-8', errors='replace').replace('\r\n', '\n').partition('----------\n')[2].split('\n\n'):
            fields = dict(line.split(' = ', 1) for line in block.split('\n') if ' = ' in line)
            if 'Path' in fields and fields.get('Folder') != '+' and not fields.get('Attributes', '').startswith('D'):
                entries.append(fields)
        duplicates = Counter(item['Path'].casefold() for item in entries)
        for item in entries:
            name = item['Path']
            issue = ''
            if item.get('Encrypted') == '+':
                issue = '成员已加密'
            elif any(key in item for key in ('Symbolic Link', 'Hard Link', 'Alternate Stream')):
                issue = '链接或特殊成员已跳过'
            elif duplicates[name.casefold()] > 1:
                issue = '包内路径重复'

            def read(maximum):
                return run_7z(executable, ['x', '-so', '-spd', '-bd', '-y', '--', str(path), name], maximum, deadline)

            size = item.get('Size', '')
            yield name, int(size) if size.isascii() and size.isdigit() and len(size) < 16 else -1, issue, read


def members(data, name, suffix, deadline):
    if suffix == '.zip':
        yield from zip_members(data)
    elif suffix in ('.7z', '.rar'):
        yield from seven_zip_members(data, suffix, deadline)
    elif suffix == '.tar' or suffix in TAR_COMPRESSION:
        if suffix in TAR_COMPRESSION:
            with TAR_COMPRESSION[suffix](io.BytesIO(data)) as stream:
                data = read_limited(stream, MAX_EXPANDED)
        yield from tar_members(data)
    else:
        def read(maximum):
            with STREAM_COMPRESSION[suffix](io.BytesIO(data)) as stream:
                return read_limited(stream, maximum)
        inner_name = name[:-len(suffix)]
        yield inner_name if extension(inner_name) else inner_name + '.txt', None, '', read


def walk_archive(data, name, supported, budget, prefix='', depth=0):
    suffix = extension(name)
    for path, declared_size, issue, read in members(data, name, suffix, budget['deadline']):
        if time.monotonic() >= budget['deadline']:
            raise ArchiveProblem('压缩包处理超时，已保留此前结果')
        if budget['entries'] >= MAX_ENTRIES:
            raise ArchiveProblem('达到包内文件数量上限，已保留此前结果')
        budget['entries'] += 1
        normalized = safe_path(path)
        location = prefix + (normalized or '无效路径')
        inner_name = PurePosixPath(normalized).name if normalized else ''
        inner_suffix = extension(inner_name)
        maximum = min(MAX_EXPANDED - budget['bytes'], MAX_MEMBER)
        if not normalized or not inner_name:
            issue = '包内路径无效'
        elif not issue and inner_suffix not in supported and inner_suffix not in ARCHIVES:
            issue = '暂不支持此格式'
        elif not issue and declared_size is not None and (declared_size < 0 or declared_size > maximum):
            issue = '成员体积超出上限'
        elif not issue and inner_suffix in ARCHIVES and depth + 1 >= MAX_DEPTH:
            issue = '达到嵌套层数上限'
        if issue:
            yield location, None, issue
            continue

        try:
            content = read(maximum)
        except ArchiveProblem as error:
            yield location, None, str(error)
            continue
        except (OSError, EOFError, RuntimeError, ValueError, zipfile.BadZipFile, tarfile.TarError):
            yield location, None, '成员无法读取，可能已加密或损坏'
            continue
        if declared_size is not None and len(content) != declared_size:
            yield location, None, '成员实际大小与目录记录不符'
            continue
        budget['bytes'] += len(content)
        if inner_suffix in ARCHIVES:
            try:
                yield from walk_archive(content, inner_name, supported, budget, location + ' / ', depth + 1)
            except ArchiveProblem as error:
                yield location, None, str(error)
            except (OSError, EOFError, ValueError, zipfile.BadZipFile, tarfile.TarError):
                yield location, None, '内层压缩包无法读取'
        else:
            yield location, content, ''
