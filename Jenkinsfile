// 프로파일마다 다른 것 중 비밀이 아닌 것은 여기에, 비밀은 Jenkins Credentials 에 둔다.
//   nodeEnv     → Dockerfile 빌드 인자로 이미지에 굳는다(APP_ENV 는 PROFILE 그대로).
//   envFile     → Secret file credential. .env.<profile> 전체를 올려 두고, 배포 때 APP_DIR 에 놓아
//                 컨테이너의 /app/.env.<profile> 로 마운트한다. 이미지에는 들어가지 않는다.
//   port        → 이 서버에서 열 포트. dev · prod 가 한 서버에 같이 뜨므로 겹치면 안 된다.
// 배포 방식: Jenkins 가 설치된 서버에서 이미지를 빌드하고 그 자리에서 컨테이너를 띄운다(레지스트리 · SSH 없음).
def PROFILES = [
  dev : [nodeEnv: 'development', envFile: 'whale-erp-api-env-dev',  port: '8001'],
  prod: [nodeEnv: 'production',  envFile: 'whale-erp-api-env-prod', port: '8000'],
]

pipeline {
  agent any // Jenkins 서버 자신. jenkins 사용자가 docker 를 쓸 수 있어야 한다(docker 그룹). node · pnpm 은 필요 없다(이미지 안에서 빌드한다).

  parameters {
    choice(name: 'PROFILE', choices: ['dev', 'prod'], description: '배포 프로파일 (APP_ENV)')
  }

  environment {
    IMAGE   = 'whale-erp-api'
    APP_DIR = '/opt/whale-erp-api'
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
          env.HOST_PORT = cfg.port
          env.TAG = "${params.PROFILE}-${env.GIT_COMMIT.take(8)}-${env.BUILD_NUMBER}"
          currentBuild.displayName = "#${env.BUILD_NUMBER} ${env.TAG}"
        }
      }
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

    stage('Approve') {
      when { expression { params.PROFILE == 'prod' } }
      steps {
        input message: "운영에 ${env.TAG} 를 배포할까요?", ok: '배포'
      }
    }

    stage('Deploy') {
      steps {
        withCredentials([file(credentialsId: env.ENV_FILE_CRED, variable: 'ENV_FILE')]) {
          // 디렉터리는 700 으로 서버의 다른 사용자를 막고, 파일은 644 로 둔다 — 컨테이너의 node 사용자(uid 1000)가
          // 마운트된 파일을 읽어야 하기 때문이다.
          // 마운트하는 이유: docker run --env-file 은 따옴표를 벗기지 않아, dotenv 로 읽던 따옴표 값이 다르게 들어간다.
          sh '''
            mkdir -p $APP_DIR && chmod 700 $APP_DIR
            install -m 644 "$ENV_FILE" $APP_DIR/.env.$PROFILE

            (docker rm -f whale-erp-api-$PROFILE || true)
            docker run -d --name whale-erp-api-$PROFILE --restart unless-stopped \
              -p $HOST_PORT:8000 \
              -v $APP_DIR/.env.$PROFILE:/app/.env.$PROFILE:ro \
              $IMAGE:$TAG

            # 필수 env 가 비면 부팅 단계에서 멈추므로, 뜬 것까지 확인한다.
            # Jenkins 가 컨테이너 안에서 돌아 localhost 는 Jenkins 자신이다 — 호스트에 뜬 api 는 host.docker.internal 로 본다.
            for i in $(seq 1 30); do
              curl -sf host.docker.internal:$HOST_PORT/ >/dev/null && exit 0
              sleep 2
            done
            docker logs --tail 50 whale-erp-api-$PROFILE
            exit 1
          '''
        }
      }
    }
  }

  post {
    // 성공했을 때만 빌드 캐시를 비운다. -a 를 붙이지 않아 지금 이미지가 쓰는 층(의존성 설치 층)의 캐시는 남는다.
    success { sh 'docker builder prune -f || true' }
    always { sh 'docker image prune -f || true' }
  }
}
