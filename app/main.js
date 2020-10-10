const qtng = require("./qtng.js");

let operations = new qtng.CoroutineGroup();
let event = new qtng.Event();

function output(text) {
    document.querySelector("#text-output").innerHTML += text + "\n";
}

operations.spawn(async () => {
    let lines = [];
    for (let i = 0; i < 5; ++i) {
        await qtng.msleep(1000);
        output(i);
    }
    event.set("ok");
});

let t = operations.spawn(async () => {
    let msg = await event.wait();
    output(msg);
    let r = await qtng.http.get("/test-data.html");
    if (r.isOk) {
        output(r.data);
    } else {
        console.debug(r.error);
    }
});

(async () => {
    let msg = await event.wait();
    //t.kill();
    output("msg from implicit coroutinne: " + msg);
})();
