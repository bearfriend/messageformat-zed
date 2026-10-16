// JavaScript example
const messages = {
  welcome: "Welcome, {name}!",
  items: "{count, plural, =0 {No items} one {# item} other {# items}}",
  notification: "{gender, select, male {He} female {She} other {They}} liked your post"
};

// Template literal example
const greeting = `Hello, {name}! You have {count, plural, 
  =0 {no messages}
  one {# message}
  other {# messages}
}`;

// i18n function call example
i18n.t("You have {count, plural, =0 {no notifications} one {# notification} other {# notifications}}");

// React-intl example
const MyComponent = () => (
  <FormattedMessage
    id="welcome"
    defaultMessage="Welcome to {site}, {name}!"
    values={{
      site: "My App",
      name: userName
    }}
  />
);