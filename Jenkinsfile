// 프로파일마다 다른 것 중 비밀이 아닌 것은 여기에, 비밀은 Jenkins Credentials 에 둔다.
//   nodeEnv     → Dockerfile 빌드 인자로 이미지에 굳는다(APP_ENV 는 PROFILE 그대로).
//   envFile     → Secret file credential. .env.<profile> 전체를 올려 두고, 배포 때 서버에 놓아
//                 컨테이너의 /app/.env.<profile> 로 마운트한다. 이미지에는 들어가지 않는다.
//   host · port → 배포 서버와 그 서버에서 열 포트.
// TODO: 레지스트리 · 서버 주소 · credential ID 를 실제 값으로 바꾼다.
def PROFILES = [
  dev : [nodeEnv: 'development', envFile: 'whale-erp-api-env-dev',  host: 'dev-api.whaleerp.co.kr', port: '8000'],
  prod: [nodeEnv: 'production',  envFile: 'whale-erp-api-env-prod', host: 'api.whaleerp.co.kr',     port: '8000'],
]

pipeline {
  agent any // docker 가 있는 에이전트. node · pnpm 은 필요 없다(이미지 안에서 빌드한다).

  parameters {
    choice(name: 'PROFILE', choices: ['dev', 'prod'], description: '배포 프로파일 (APP_ENV)')
  }

  environment {
    AWS_DEFAULT_REGION = 'ap-northeast-2'
    REGISTRY = '494501706948.dkr.ecr.ap-northeast-2.amazonaws.com'
    IMAGE    = "${REGISTRY}/interplug/whale-erp-api"
    AWS_CRED = 'whale-erp-aws'
    SSH_CRED = 'whale-erp-deploy-ssh'
    APP_DIR  = '/opt/whale-erp-api'
  }

  options {
    disableConcurrentBuilds()
    timestamps()
  }

  stages {
    stage('Prepare') {
      steps {
        script {
          def cfg = PROFILES[params.PROFILE]
          env.NODE_ENV_ARG = cfg.nodeEnv
          env.ENV_FILE_CRED = cfg.envFile
          env.DEPLOY_HOST = cfg.host
          env.HOST_PORT = cfg.port
          env.TAG = "${params.PROFILE}-${env.GIT_COMMIT.take(8)}-${env.BUILD_NUMBER}"
          currentBuild.displayName = "#${env.BUILD_NUMBER} ${env.TAG}"
        }
      }
    }

    stage('Test') {
      steps {
        // Dockerfile 의 build 단계(개발 의존성 포함)에서 단위 테스트를 돌린다. 아래 Build 는 이 층을 캐시로 다시 쓴다.
        sh '''
          docker build --target build -t whale-erp-api:test-$BUILD_NUMBER .
          docker run --rm whale-erp-api:test-$BUILD_NUMBER pnpm test
        '''
      }
      post { always { sh 'docker image rm -f whale-erp-api:test-$BUILD_NUMBER || true' } }
    }

    stage('Build') {
      steps {
        sh '''
          docker build \
            --build-arg APP_ENV=$PROFILE \
            --build-arg NODE_ENV=$NODE_ENV_ARG \
            -t $IMAGE:$TAG -t $IMAGE:$PROFILE-latest .
        '''
      }
    }

    stage('Push') {
      steps {
        withCredentials([aws(credentialsId: env.AWS_CRED)]) {
          sh '''
            aws ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY"
            docker push $IMAGE:$TAG
            docker push $IMAGE:$PROFILE-latest
          '''
        }
      }
    }

    stage('Approve') {
      when { expression { params.PROFILE == 'prod' } }
      steps {
        input message: "운영에 ${env.TAG} 를 배포할까요?", ok: '배포'
      }
    }

    stage('Deploy') {
      steps {
        withCredentials([
          file(credentialsId: env.ENV_FILE_CRED, variable: 'ENV_FILE'),
          sshUserPrivateKey(credentialsId: env.SSH_CRED, keyFileVariable: 'SSH_KEY'),
          aws(credentialsId: env.AWS_CRED),
        ]) {
          // 디렉터리는 700 으로 서버의 다른 사용자를 막고, 파일은 644 로 둔다 — 컨테이너의 node 사용자(uid 1000)가
          // 마운트된 파일을 읽어야 하기 때문이다.
          // 마운트하는 이유: docker run --env-file 은 따옴표를 벗기지 않아, dotenv 로 읽던 따옴표 값이 다르게 들어간다.
          sh '''
            SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new $DEPLOY_HOST"
            $SSH "mkdir -p $APP_DIR && chmod 700 $APP_DIR"
            scp -i $SSH_KEY -o StrictHostKeyChecking=accept-new "$ENV_FILE" $DEPLOY_HOST:$APP_DIR/.env.$PROFILE
            $SSH "chmod 644 $APP_DIR/.env.$PROFILE"

            # 배포 서버에는 AWS 자격 증명을 두지 않고, 에이전트가 받은 ECR 토큰(12시간)만 넘긴다.
            aws ecr get-login-password | $SSH "docker login --username AWS --password-stdin $REGISTRY"
            $SSH "docker pull $IMAGE:$TAG \
              && (docker rm -f whale-erp-api-$PROFILE || true) \
              && docker run -d --name whale-erp-api-$PROFILE --restart unless-stopped \
                   -p $HOST_PORT:8000 \
                   -v $APP_DIR/.env.$PROFILE:/app/.env.$PROFILE:ro \
                   $IMAGE:$TAG"

            # 필수 env 가 비면 부팅 단계에서 멈추므로, 뜬 것까지 확인한다.
            for i in $(seq 1 30); do
              $SSH "curl -sf localhost:$HOST_PORT/ >/dev/null" && exit 0
              sleep 2
            done
            $SSH "docker logs --tail 50 whale-erp-api-$PROFILE"
            exit 1
          '''
        }
      }
    }
  }

  post {
    always { sh 'docker image prune -f || true' }
  }
}
