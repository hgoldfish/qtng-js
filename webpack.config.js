//webpack.config.js
module.exports = {
    mode: "development",
    devtool: "eval-source-map", 
    entry: __dirname + "/app/main.js",
    output: {
        path: __dirname + "/build",
        filename: "bundle.js"
    },
    devServer: {
        contentBase: "./build",
        historyApiFallback: true,
        inline: true,
    },
}
