function removeItemAll(arr, value) {
    var i = 0;
    while (i < arr.length) {
        if (arr[i] === value) {
            arr.splice(i, 1);
        } else {
            ++i;
        }
    }
    return arr;
}

const CoroutineExitException = Symbol("CoroutineExitException");
const CoroutineRuntimeException = Symbol("CoroutineRuntimeException");
let currentCoroutine = null;

class YieldHelper {
    constructor() {
        this.resolve = null;
        this.promise = null;
    }

    isPaused() {
        return this.promise != null;
    }

    pause() {
        if (this.promise == null) {
            this.promise = new Promise((resolve, _) => {
                this.resolve = resolve;
            });
        }
        return this.promise;
    }

    resume(value) {
        if (this.resolve) {
            let resolve = this.resolve;
            this.resolve = null;
            this.promise = null;
            setTimeout(() => resolve(value), 0);
        }
    }
}

let nextId = 1;

class Coroutine {
    constructor(func, args) {
        this.func = func;
        this.args = args;
        this.finished = new Promise((resolve, _) => {
            this.finished_resolve = resolve;
        });
        this.yieldHelper = new YieldHelper();
        this.yieldHelper.pause();
        this.started = 0;
        this.id = nextId++;
    }

    start() {
        if (this.started) {
            return;
        }
        this.started = setTimeout(async () => {
            if (!this.started) { // cancelled
                return;
            }
            this.yieldHelper.resume();
            currentCoroutine = this;
            let ok = true;
            let result = undefined;
            try {
                result = await this.func(...this.args);
            } catch (e) {
                if (e !== CoroutineExitException) {
                    console.error("got unhandled coroutine exception:", e);
                    ok = false;
                }
            }
            this.started = 0;
            currentCoroutine = null;
            this.finished_resolve([ok, result]);
        }, 0);
    }

    yield() {
        // can not yield to myself.
        if (!this.yieldHelper.isPaused()) {
            console.debug("yield current coroutine.");
            throw CoroutineRuntimeException;
        }
        this.yieldHelper.resume(undefined);
    }

    raise(e) {
        // can not kill myself.
        if (!this.yieldHelper.isPaused()) {
            console.debug("raise current coroutine.");
            throw CoroutineRuntimeException;
        }
        this.yieldHelper.resume(e);
    }

    kill() {
        if (!this.started) {
            return;
        }
        this.raise(CoroutineExitException);
    }

    async pause() {
        // ensure I am the currentCoroutine
        if (this.yieldHelper.isPaused()) {
            throw CoroutineRuntimeException;
        }
        currentCoroutine = null;
        let e = await this.yieldHelper.pause();
        currentCoroutine = this;
        if (e !== undefined) {
            throw e;
        }
    }

    isRunning() {
        return this.started && !this.yieldHelper.isPaused();
    }

    async join() {
        let [ok, result] = await this.finished.wait();
        if (ok) {
            return result;
        } else {
            throw result;
        }
    }

    static spawn(func, ...args) {
        let coroutine = new Coroutine(func, args);
        coroutine.start();
        return coroutine;
    }

    static getCurrent() {
        if (currentCoroutine == null) {
            currentCoroutine = new Coroutine(null, null);
            currentCoroutine.yieldHelper.resume();
            currentCoroutine.started = 1;
        } else {
            if (!currentCoroutine.isRunning()) {
                throw CoroutineRuntimeException;
            }
        }
        return currentCoroutine;
    }
}


class Semaphore {
    constructor(initValue) {
        if (initValue <= 0) {
            console.error("Semaphore initValue: ", initValue);
        }
        this.initValue = initValue;
        this.counter = 0;
        this.notified = 0;
        this.waiters = [];
    }

    async acquire(nonBlocking) {
        if (this.counter > 0) {
            --this.counter;
            return true;
        }
        if (nonBlocking) {
            return false;
        }
        let c = Coroutine.getCurrent();
        this.waiters.push(c);
        try {
            await c.pause();
        } finally {
            removeItemAll(this.waiters, c);
        }
        return true;
    }

    release(value) {
        if (value <= 0) {
            return;
        }
        this.counter += value;
        if (this.counter > this.initValue) {
            this.counter = this.initValue;
        }
        if (!this.notified && this.waiters.length > 0) {
            this.notified = setTimeout(() => {
                if (this.notified == 0) {
                    return;
                }
                while (this.waiters.length > 0 && this.counter > 0) {
                    let waiter = this.waiters.unshift();
                    --this.counter;
                    waiter.yield();
                }
                this.notified = 0;
            }, 0);
        }
    }

    isLocked() {
        return this.counter <= 0;
    }

    isUsed() {
        return this.counter < this.initValue;
    }
}

class Lock extends Semaphore{
    constructor() {
        super(1);
    }
}

class Event {
    constructor() {
        this.flag = false;
        this.value = null;
        this.waiters = [];
    }

    isSet() {
        return this.flag;
    }

    set(value) {
        this.value = value;
        if (!this.flag) {
            this.flag = true;
            while (this.waiters.length > 0) {
                let waiter = this.waiters.shift();
                waiter.yield();
            }
        }
    }

    clear() {
        this.flag = false;
        this.value = null;
    }

    async wait() {
        if (!this.flag) {
            let c = Coroutine.getCurrent();
            this.waiters.push(c);
            try {
                await c.pause();
            } finally {
                removeItemAll(this.waiters, c);
            }
        }
        return this.value;
    }
}


async function msleep(msecs) {
    let c = Coroutine.getCurrent();
    let timerId = 0;
    timerId = setTimeout(() => {
        if (c != null) {
            c.yield();
        }
    }, msecs);
    try {
        return await c.pause();
    } finally {
        clearTimeout(timerId);
        c = null;
    }
}

async function sleep(seconds) {
    return await msleep(seconds * 1000);
}

class CoroutineGroup {
    constructor() {
        this.coroutines = new Map();
    }

    spawn(func, ...args) {
        return this.spawnWithName(this.randomName(), func, ...args);
    }

    spawnWithName(name, func, ...args) {
        let coroutine = Coroutine.spawn(func, args);
        coroutine.name = name;
        this.coroutines.set(name, coroutine);
        coroutine.finished.finally(() => {
            if (coroutine === this.coroutines.get(name)) {
                this.coroutines.delete(name);
            }
        });
        return coroutine;
    }

    randomName(length) {
        var result = '';
        var characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        var charactersLength = characters.length;
        for ( var i = 0; i < length; i++ ) {
            result += characters.charAt(Math.floor(Math.random() * charactersLength));
        }
        return result;
    }

    get(name) {
        return this.coroutines.get(name);
    }

    has(name) {
        return this.coroutines.has(name);
    }

    delete(name) {
        this.coroutines.delete(name);
    }

    kill(name, notWait) {
        let coroutine = this.coroutines.get(name);
        if (coroutine) {
            coroutine.kill();
            if (!notWait) {
                this.coroutines.delete(name);
            }
        }
    }

    killall() {
        for (let coroutine of this.coroutines.values()) {
            if (currentCoroutine !== coroutine) {
                coroutine.kill();
            }
        }
    }

    async join(name) {
        let coroutine = this.coroutines.get(name);
        if (coroutine) {
            await coroutine.join();
        }

    }

    async joinall() {
        for ([name, coroutine] of this.coroutines) {
            if (currentCoroutine !== coroutine) {
                await coroutine.join();
            }
        }
    }

    async map(func, list) {
        let coroutines = [];
        for (let job of list) {
            coroutines.push(Coroutine.spawn(func, job));
        }
        let results = [];
        for (let coroutine of coroutines) {
            results.push(coroutine.join());
        }
        return results;
    }

    async each(func, list) {
        let coroutines = [];
        for (let job of list) {
            coroutines.push(Coroutine.spawn(func, job));
        }
        for (let coroutine of coroutines) {
            coroutine.join();
        }
    }
}

function fiber(target, name, descriptor) {
    let wrapped = target[name];
    let wrapper = function (...args) {
        if (!target.operations) {
            target.operations = new CoroutineGroup();
        }
        target.operations.spawnWithName(name, wrapped.bind(target), ...args);
    }
    return wrapper;
}

function promisify(wrapped, successKey, failKey) {
    if (!successKey) {
        successKey = "success";
    }
    if (!failKey) {
        failKey = "fail";
    }
    let wrapper = async function(args) {
        let done = false;
        let ok = true;
        let result = undefined;
        let c = Coroutine.getCurrent();
        let d = {...(args || {})};
        d[successKey] = res => {
            done = true;
            result = res;
            if (c != null) {
                c.yield();
            }
        };
        d[failKey] = res => {
            done = true;
            ok = false;
            result = res;
        };
        let task = wrapped(d);
        if (!done) {
            try {
                await c.pause();
            } catch (e) {
                if (task.abort) {
                    try {
                        task.abort();
                    } catch (e) {
                        // not an error.
                    }
                }
                throw e;
            } finally {
                c = null;
            }
        }
        if (ok) {
            return result;
        } else {
            throw result;
        }
    };
    return wrapper;
}

async function jsAwait(onFunc, offFunc) {
    let done = false;
    let c = Coroutine.getCurrent();
    let result = undefined;
    let d = {
        callback: function (arg) {
            done = true;
            result = arg;
            if (offFunc) {
                offFunc(this.callback);
            }
            if (c != null) {
                c.yield();
            }
        }
    };
    d["callback"] = d["callback"].bind(d);
    onFunc(d["callback"]);
    if (!done) {
        try {
            await c.pause();
        } finally {
            c = null;
        }
    }
    return result;
}

class CookieJar {

}

class Request {
    constructor() {
        this.method = "GET";
        this.url = "";
        this.query = null;
        this.data = null;
        this.headers = null;
    }
}

class Response {
    constructor() {
        this.url = "";
        this.statusCode = 0;
        this.statusText = "";
        this.headers = new Map();
        this.data = null;
        this.error = null;
    }

    get isOk() {
        return this.error == null && 0 < this.statusCode && this.statusCode < 400;
    }

    hasHttpError() {
        return this.error == null && this.statusCode >= 400;
    }

    hasNetworkError() {
        return this.error != null;
    }

    get text() {
        return this.data;
    }

    get json() {
        if (this.data) {
            return JSON.parse(this.data);
        } else {
            return {};
        }
    }
}

class BaseSession {
    get(url, query) {
        let request = new Request();
        request.method = "GET";
        request.url = url;
        request.query = query;
        return this.send(request);
    }

    head(url, query) {
        let request = new Request();
        request.method = "GET";
        request.url = url;
        request.query = query;
        return this.send(request);
    }

    post(url, data) {
        let request = new Request();
        request.method = "POST";
        request.url = url;
        request.data = data;
        return this.send(request);
    }

    put(url, data) {
        let request = new Request();
        request.method = "PUT";
        request.url = url;
        request.data = data;
        return this.send(request);
    }

    patch(url, data) {
        let request = new Request();
        request.method = "PUT";
        request.url = url;
        request.data = data;
        return this.send(request);
    }

    delete(url, data) {
        let request = new Request();
        request.method = "PUT";
        request.url = url;
        request.data = data;
        return this.send(request);
    }
}

var cookieStore = null;

class WeixinSession extends BaseSession {
    async send(request) {
        let c = Coroutine.getCurrent();
        let d = {
            "method": request.method,
            "url": request.url,
        };
        if (request.query) {
            d["data"] = request.query;
        } else if (request.data) {
            d["data"] = request.data;
        }
        if (request.headers) {
            d["header"] = {};
            for (let [k, v] of request.headers) {
                d["header"][k] = v;
            }
        }
        d["dataType"] = "text";
        d["responseType"] = "text";

        this.mergeCookies(request.url, d);
        let response = new Response();
        response.url = request.url;

        let done = false;
        d["success"] = (resp) => {
            done = true;
            response.statusCode = resp.statusCode;
            for (const headerName of Object.keys(resp.header)) {
                response.headers[headerName] = resp.header[headerName];
            }
            response.data = resp.data;
            if (c != null) {
                c.yield();
            }
        };
        d["fail"] = (error) => {
            done = true;
            response.error = error;
            if (c != null) {
                c.yield();
            }
        };
        let task = wx.request(d);
        if (!done) {
            try {
                await c.pause();
            } catch (e) {
                if (!done) {
                    task.cancel();
                }
                throw e;
            } finally {
                c = null;
            }
        }
        return response;
    }

    mergeCookies(url, d) {
        if (cookieStore === null) {
            cookieStore = new Map();
            try {
                let data = JSON.parse(wx.getStorageSync("cookies"));
                for (let cookieName in data) {
                    if (!data.hasOwnProperty(cookieName)) {
                        continue;
                    }
                    cookieStore[cookieName] = data[cookieName];
                }
            } catch (e) {
            }
        }
    
        if (d["header"] && d["header"]["Cookie"]) {
            return;
        }
        let l = [];
        for (let cookieName in cookieStore) {
            l.push(cookieName + "=" + cookieStore[cookieName]);
        }
        if (d["header"]) {
            d["header"]["Cookie"] = l.join(";");
        } else {
            d["header"] = {"Cookie": l.join(";")};
        }
    }

    storeCookies(d) {
        if (cookieStore === null) {
            cookieStore = new Map();
        }
    
        if (!d["header"]) {
            return;
        }
    
        for (let headerName in d["header"]) {
            if (!d["header"].hasOwnProperty(headerName)) {
                continue;
            }
            if (headerName.toUpperCase() === "Set-Cookie".toUpperCase()) {
                let cookieHeader = d["header"][headerName]
                let cookies = this.parseCookies(cookieHeader);
                for (let cookieName in cookies) {
                    cookieStore[cookieName] = cookies[cookieName];
                }
            }
        }
        wx.setStorage({
            key: "cookies",
            data: JSON.stringify(cookieStore),
        });
    }

    parseCookies(cookieHeader) {
        let lines = cookieHeader.split(",");
        let cookies = new Map();
        for (let cookie of lines) {
            let parts = cookie.split(";");
            if (parts.length >= 1) {
                let kv = parts[0].split("=");
                if (kv.length == 2) {
                    cookies[kv[0].trim()] = kv[1].trim();
                }
            }
        }
        return cookies;
    }
}


class BrowserSession extends BaseSession {
    async send(request) {
        let c = Coroutine.getCurrent();
        let response = new Response();
        response.url = request.url;
        let xhr = new XMLHttpRequest();
        let done = false;
        xhr.addEventListener("load", () => {
            done = true;
            response.statusCode = xhr.status;
            response.statueText = xhr.statusText;
            response.data = xhr.responseText;
            if (c != null) {
                c.yield();
            }
        });
        xhr.addEventListener("error", (e)=> {
            done = true;
            response.error = e;
            if (c != null) {
                c.yield();
            }
        });
        xhr.open(request.method.toUpperCase(), request.url, true);
        xhr.responseType = "text";
        if (request.header) {
            for (let headerName of Object.keys(request.headers)) {
                xhr.setRequestHeader(key, request.headers[headerName]);
            }
        }
        xhr.send(request.data);
        if (!done) {
            try {
                await c.pause();
            } catch (e) {
                if (!done) {
                    xhr.abort();
                }
                throw e;
            } finally {
                c = null;
            }
        }
        return response;
    }
}


class DummySession extends BaseSession {
    async send(reqeust) {
        let response = new Response();
        response.url = request.url;
        return response;
    }
}

const NodeSession = DummySession;

var Session;
try {
    if (wx && wx.request) {
        Session = WeixinSession;
    }
} catch (e) {
    // TODO support nodejs.
    if (XMLHttpRequest) {
        Session = BrowserSession;
    } else {
        Session = DummySession;
    }
}

const http = new Session();

module.exports = {
    CoroutineRuntimeException,
    Coroutine,
    Event,
    Lock,
    msleep,
    sleep,
    CoroutineGroup,
    fiber,
    promisify,
    jsAwait,
    Request,
    Response,
    Session,
    http,
};
