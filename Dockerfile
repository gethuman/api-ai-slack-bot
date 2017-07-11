FROM node:7.10.0

RUN mkdir -p /usr/gethuman/src
WORKDIR /usr/gethuman
COPY . /usr/gethuman

RUN npm install
RUN chmod +x start.sh

CMD ["./start.sh"]
