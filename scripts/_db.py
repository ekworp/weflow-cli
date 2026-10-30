"""
微信库连接的两个最小助手：`open_db` 与 `get_name_map`。

为什么单独一个模块、而不是塞进 `_utils`：`_utils` 被 50 多个脚本 import，而它本身
不依赖 sqlcipher；把连接函数放进去，会让所有脚本在 import 时都要求装 sqlcipher3。
这里把 `from sqlcipher3 import dbapi2` 放在 `open_db` 内部，只有真的连库时才需要它
（`extract_todos` 一直就是这么做的）。

同一个 `PRAGMA key = "x'<key><salt>'"` 原来在 annual_report / chat_report / chat_stats /
extract_todos / mcp_bridge 各有一份：改一处漏三处的风险比行长更值得处理（D-141）。
"""
import os


def open_db(db_path, key_hex, salt_hex):
    """用 NT 的 key+salt 打开一个库。调用方负责 `conn.close()`。"""
    try:
        from sqlcipher3 import dbapi2 as sqlcipher
    except ImportError as exc:
        raise RuntimeError('请安装: pip install sqlcipher3') from exc
    raw_key = f"x'{key_hex}{salt_hex}'"
    conn = sqlcipher.connect(db_path)
    c = conn.cursor()
    c.execute(f'PRAGMA key = "{raw_key}";')
    c.execute("SELECT count(*) FROM sqlite_master")
    return conn


def get_name_map(contact_db, contact_key, contact_salt):
    """contact 库 → `{username: 备注名/昵称/username}`。读不到就回空表，不猜。"""
    name_map = {}
    if not contact_db or not contact_key or not os.path.exists(contact_db):
        return name_map
    try:
        conn = open_db(contact_db, contact_key, contact_salt)
        c = conn.cursor()
        c.execute("SELECT username, COALESCE(NULLIF(remark,''), NULLIF(nick_name,''), username) FROM contact")
        for r in c.fetchall():
            name_map[r[0]] = r[1]
        conn.close()
    except:  # 与原来的拷贝一致：读联系人失败不该让整次报告中断
        pass
    return name_map
