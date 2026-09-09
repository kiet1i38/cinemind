const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");

module.exports = (_, argv = {}) => ({
  entry: {
    app: path.resolve(__dirname, "src/index.jsx"),
    reset: path.resolve(__dirname, "src/adminReset.jsx"),
    auth: path.resolve(__dirname, "src/auth.jsx"),
    profile: path.resolve(__dirname, "src/profile.jsx")
  },
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "assets/[name].[contenthash:8].js",
    clean: true,
    publicPath: "./"
  },
  resolve: {
    extensions: [".js", ".jsx"]
  },
  module: {
    rules: [
      {
        test: /\.(js|jsx)$/,
        exclude: /node_modules/,
        use: "babel-loader"
      },
      {
        test: /\.css$/,
        use: ["style-loader", "css-loader", "postcss-loader"]
      }
    ]
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: path.resolve(__dirname, "public/index.html"),
      filename: "index.html",
      chunks: ["app"],
      favicon: path.resolve(__dirname, "public/favicon.svg"),
      title: "CineMind"
    }),
    new HtmlWebpackPlugin({
      template: path.resolve(__dirname, "public/reset.html"),
      filename: "reset.html",
      chunks: ["reset"],
      favicon: path.resolve(__dirname, "public/favicon.svg"),
      title: "CineMind Admin Reset"
    }),
    new HtmlWebpackPlugin({
      template: path.resolve(__dirname, "public/auth.html"),
      filename: "auth.html",
      chunks: ["auth"],
      favicon: path.resolve(__dirname, "public/favicon.svg"),
      title: "CineMind Account"
    }),
    new HtmlWebpackPlugin({
      template: path.resolve(__dirname, "public/profile.html"),
      filename: "profile.html",
      chunks: ["profile"],
      favicon: path.resolve(__dirname, "public/favicon.svg"),
      title: "CineMind Profile"
    })
  ],
  devServer: {
    static: {
      directory: path.resolve(__dirname, "public")
    },
    historyApiFallback: true,
    hot: true,
    port: 5173,
    client: {
      overlay: true
    },
    proxy: [
      {
        context: ["/api"],
        target: "http://127.0.0.1:8000",
        changeOrigin: true
      }
    ]
  },
  // Keep source maps in development for debugging, but do not publish the
  // source tree alongside the production bundle.
  devtool: argv.mode === "production" ? false : "source-map"
});
