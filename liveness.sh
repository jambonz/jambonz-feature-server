#!/bin/sh

TCP_SERVER_PORT="${DRACHTIO_PORT:-4000}"
nc -v -z localhost $TCP_SERVER_PORT

# if last command exited with non zero
if [ $? != 0 ]
then
    exit 1
fi

HTTP_SERVER_PORT="${HTTP_PORT:-3000}"
printf 'GET /system-health HTTP/1.1\r\nHost: localhost\r\n\r\n' | nc -v localhost 3000 | grep calls

# grep will automatically exit with 1 if string is not matched, however, will leave that call there in case 
# we pivot to pipe to dev/null

if [ $? != 0 ]
then
    exit 1
fi

exit 0
