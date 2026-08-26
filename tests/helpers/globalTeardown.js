module.exports = async () => {
  if (global.__MONGO__) await global.__MONGO__.stop();
};
