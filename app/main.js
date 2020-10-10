const qtng = require("./qtng.js");

let operations = new qtng.CoroutineGroup();
let event = new qtng.Event();

operations.spawn(async () => {
    let output = document.querySelector("#text-output");
    let lines = [];
    for (let i = 0; i < 0; ++i) {
        await qtng.msleep(1000);
        lines.push("" + i);
        output.innerHTML = lines.join("\n");
    }
    event.set("ok");
});

operations.spawn(async () => {
    let output = document.querySelector("#text-output");
    let msg = await event.wait();
    output.innerHTML = msg;
    let r = await qtng.http.get("/test-data.html");
    if (r.isOk) {
        output.innerHTML = r.data;
    } else {
        console.debug(r.error);
    }
});
