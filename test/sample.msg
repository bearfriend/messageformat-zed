# Simple message
simple = This is a simple message

# Message with variables
welcome = Hello, {name}!

# Plural forms
items = {itemCount, plural,
    =0 {No items}
    one {# item}
    other {# items}
}

# Select statement
notification = {gender, select,
    male {He}
    female {She}
    other {They}
} liked your post.

# Nested messages
nested = {gender, select,
    male {He has {count, plural,
        one {# item}
        other {# items}
    }}
    female {She has {count, plural,
        one {# item}
        other {# items}
    }}
    other {They have {count, plural,
        one {# item}
        other {# items}
    }}
}