"""Minimal asyncio client for the Asterisk Manager Interface (AMI).

Supports plain actions, list-style actions (EventList start/Complete),
CLI commands through the Command action, and an event feed.
"""
import asyncio
import collections
import logging
import uuid

log = logging.getLogger("ami")


class AMIError(Exception):
    pass


class AMI:
    def __init__(self, host, port, user, secret):
        self.host, self.port, self.user, self.secret = host, port, user, secret
        self.reader = None
        self.writer = None
        self.connected = False
        self.version = ""
        self._pending = {}          # ActionID -> [future, events, collecting, (response)]
        self._wlock = None
        self.events = collections.deque(maxlen=500)
        self.handlers = []          # async callables(event dict)
        self._task = None

    # lifecycle ------------------------------------------------------
    def start(self):
        self._wlock = asyncio.Lock()
        self._task = asyncio.create_task(self._run())

    async def stop(self):
        if self._task:
            self._task.cancel()
        if self.writer:
            self.writer.close()

    async def _run(self):
        while True:
            try:
                await self._connect_and_serve()
            except asyncio.CancelledError:
                return
            except Exception as e:  # noqa: BLE001
                log.warning("AMI connection lost: %s", e)
            self.connected = False
            for aid, entry in list(self._pending.items()):
                if not entry[0].done():
                    entry[0].set_exception(AMIError("AMI disconnected"))
            self._pending.clear()
            await asyncio.sleep(5)

    async def _connect_and_serve(self):
        self.reader, self.writer = await asyncio.open_connection(self.host, self.port)
        banner = (await self.reader.readline()).decode(errors="replace").strip()
        self.version = banner
        reader_task = asyncio.create_task(self._read_loop())
        try:
            resp = await self._action("Login", {"Username": self.user, "Secret": self.secret, "Events": "on"})
            if resp["response"].get("Response") != "Success":
                raise AMIError("AMI login failed: " + str(resp["response"].get("Message", "")))
            self.connected = True
            log.info("AMI connected (%s)", banner)
            await reader_task
        finally:
            reader_task.cancel()
            self.writer.close()

    # wire protocol --------------------------------------------------
    async def _read_loop(self):
        pkt = {}
        while True:
            line = await self.reader.readline()
            if not line:
                raise AMIError("connection closed")
            line = line.decode(errors="replace").rstrip("\r\n")
            if line == "":
                if pkt:
                    self._dispatch(pkt)
                    pkt = {}
                continue
            if ": " in line:
                k, v = line.split(": ", 1)
            elif line.endswith(":"):
                k, v = line[:-1], ""
            else:
                k, v = "Output", line
            if k in pkt:
                if isinstance(pkt[k], list):
                    pkt[k].append(v)
                else:
                    pkt[k] = [pkt[k], v]
            else:
                pkt[k] = v

    def _dispatch(self, pkt):
        aid = pkt.get("ActionID")
        if "Response" in pkt and aid in self._pending:
            entry = self._pending[aid]
            if str(pkt.get("EventList", "")).lower() == "start":
                entry[2] = True
                entry.append(pkt)
                return
            self._pending.pop(aid, None)
            if not entry[0].done():
                entry[0].set_result({"response": pkt, "events": entry[1]})
            return
        if "Event" in pkt and aid in self._pending and self._pending[aid][2]:
            entry = self._pending[aid]
            if str(pkt.get("EventList", "")).lower() == "complete":
                self._pending.pop(aid, None)
                if not entry[0].done():
                    entry[0].set_result({"response": entry[3], "events": entry[1]})
            else:
                entry[1].append(pkt)
            return
        if "Event" in pkt:
            self.events.append(pkt)
            for h in self.handlers:
                try:
                    asyncio.get_running_loop().create_task(h(pkt))
                except Exception:  # noqa: BLE001
                    log.exception("event handler failed")

    async def _action(self, name, params=None, timeout=15):
        aid = uuid.uuid4().hex
        fut = asyncio.get_running_loop().create_future()
        self._pending[aid] = [fut, [], False]
        lines = [f"Action: {name}", f"ActionID: {aid}"]
        for k, v in (params or {}).items():
            if isinstance(v, (list, tuple)):
                for item in v:
                    lines.append(f"{k}: {item}")
            else:
                lines.append(f"{k}: {v}")
        data = ("\r\n".join(lines) + "\r\n\r\n").encode()
        async with self._wlock:
            self.writer.write(data)
            await self.writer.drain()
        try:
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            self._pending.pop(aid, None)
            raise AMIError(f"AMI action {name} timed out")

    # public API -----------------------------------------------------
    async def action(self, name, params=None, timeout=15):
        if not self.connected:
            raise AMIError("Asterisk manager not connected")
        return await self._action(name, params, timeout)

    async def cli(self, command, timeout=30) -> str:
        """Run an Asterisk CLI command and return its text output."""
        r = await self.action("Command", {"Command": command}, timeout)
        out = r["response"].get("Output", "")
        if isinstance(out, list):
            out = "\n".join(out)
        if r["response"].get("Response") == "Error" and not out:
            out = str(r["response"].get("Message", ""))
        return out

    async def events_list(self, name, params=None):
        r = await self.action(name, params)
        return r["events"]
