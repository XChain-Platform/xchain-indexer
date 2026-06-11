# Docker notes

# create docker container from dockerfile
docker build -t xchain-indexer . 

# start up docker
docker run xchain-indexer

# start up docker in background
docker run -d xchain-indexer

# Stop docker
docker ps | grep xchain-indexer | awk '{print $1}' | xargs docker stop

# List all containers
docker container ls -a

# remove all containers
docker container prune



# Node install notes
git clone git@github.com:XChain-platform/xchain-node.git
cd xchain-node/
sudo ln -s ~/xchain-node/xchain-node.sh /usr/local/bin/xchain-node
npm install
xchain-node

# add user to docker group



# Build docker and start up indexer
docker build -t xchain-indexer . ; docker run xchain-indexer


# mysql notes (separate install only)
CREATE USER 'xchain-node'@'%' IDENTIFIED BY 'ß';
GRANT ALL PRIVILEGES on *.* TO 'xchain-node'@'%' WITH GRANT OPTION;

# Reset indexer database 
drop database XChain_Indexer;create database XChain_Indexer;use XChain_Indexer;



Node Installation notes
```
sudo apt update
sudo apt install nodejs npm


- Install docker
sudo apt update
sudo apt install ca-certificates curl gnupg -y
sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

- add user to `docker` group

cd ~
git clone git@github.com:XChain-platform/xchain-node.git
cd xchain-node/
sudo ln -s ~/xchain-node/xchain-node.sh /usr/local/bin/xchain-node
npm install
xchain-node


- Follow sync progress in docker container
docker logs --follow --tail 10 CONTAINER_ID

docker exec -it CONTAINER_ID mariadb -u root -p

docker exec -it 28e7a912fe76 mariadb -u root -p


docker start <container_name_or_id>
docker exec -it <container_name_or_id> /bin/bash


CREATE USER 'xchain-node'@'%' IDENTIFIED BY '<password>';
GRANT ALL PRIVILEGES ON *.* TO 'xchain-node'@'%';

```


- add ability to install multiple networks at once.... instead of having to install each chain/network combo

- error thrown when first running index.js
https://i.gyazo.com/875c2164abdda3146ebe7837f02f5a32.png

- error thrown when trying to install bitcoin / litecoin / dogecoin
https://i.gyazo.com/b97b5773b9689bfda8a05f665097c0b7.png

- selecting "install/configure database" throws error and goes back to main menu
https://i.gyazo.com/8f097730b7ff9bafd2543996036abb0c.png

- selecting "Scan already installed modules" crashes
https://i.gyazo.com/5cede373f9cda23b8cca12f16bd1008f.png



xchain-node 
db user: root
db pass: <password>

