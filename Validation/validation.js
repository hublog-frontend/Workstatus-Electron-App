const emailRegex =
  /^[a-zA-Z0-9]+([._-]?[a-zA-Z0-9]+)*@([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/;

const emailValidator = (email) => {
  let error = "";
  if (!email || email.length <= 0) error = "Email is required";
  else if (!emailRegex.test(email)) error = "Email is not valid";
  return error;
};

const passwordValidator = (password) => {
  let error = "";
  if (!password || password.length <= 0) {
    error = "Password is required";
  }
  return error;
};
